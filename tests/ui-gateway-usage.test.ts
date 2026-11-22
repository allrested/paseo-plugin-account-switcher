import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { BDDEV_USAGE, type Account } from "../shared/contracts";

const fixture=vi.hoisted(()=>{
  let slots:unknown[]=[],index=0;
  return {
    reset(){slots=[];index=0;},render(){index=0;},
    useState<T>(initial:T|(()=>T)){const slot=index++;if(!(slot in slots))slots[slot]=typeof initial==="function"?(initial as ()=>T)():initial;return [slots[slot] as T,(next:T|((value:T)=>T))=>{slots[slot]=typeof next==="function"?(next as (value:T)=>T)(slots[slot] as T):next;}] as const;},
    rpc:vi.fn(),runs:[] as Promise<unknown>[],
  };
});
vi.mock("react",async original=>({...await original<typeof import("react")>(),useState:fixture.useState,useEffect:()=>{}}));
vi.mock("react-native",()=>({View:"View",Text:"Text",TextInput:"TextInput",Pressable:"Pressable"}));
vi.mock("@getpaseo/plugin/client",()=>({useRpc:(contract:{name:string})=>(input:unknown)=>fixture.rpc(contract.name,input)}));
vi.mock("@getpaseo/plugin/client/react-native",()=>({Icon:"Icon"}));
vi.mock("../client/data",()=>({useAction:()=>({isPending:false,error:null,run:(action:()=>Promise<unknown>)=>{fixture.runs.push(action());}})}));
const {GatewayUsageForm}=await import("../client/gateway-usage");
const {formFromUsage,usageFromForm}=await import("../client/gateway-usage-form");
const {Button,Field,Segmented}=await import("../client/components");

type Node=ReactElement<{onFocus?():void;children?:unknown;label?:string;disabled?:boolean;onPress?():void;accessibilityLabel?:string;onChangeText?(text:string):void;value?:string;onChange?(value:string):void;options?:{value:string;label:string}[]}>;
function elements(node:unknown):Node[]{
  if(Array.isArray(node))return node.flatMap(elements);
  if(!node||typeof node!=="object"||!("props" in node))return [];
  const element=node as Node;
  // Function components are rendered so their children are visible; host elements are walked as they are.
  if(typeof element.type==="function"&&![Button,Field,Segmented].includes(element.type as never))return elements((element.type as (props:unknown)=>unknown)(element.props));
  return [element,...elements(element.props.children)];
}
const button=(tree:unknown,label:string)=>elements(tree).find(e=>e.type===Button&&e.props.children===label)!;
const field=(tree:unknown,label:string)=>elements(tree).find(e=>e.type===Field&&e.props.accessibilityLabel===label)!;
const choice=(tree:unknown,label:string)=>elements(tree).find(e=>e.type===Segmented&&e.props.label===label)!;
const text=(tree:unknown)=>elements(tree).flatMap(e=>[e.props.children].flat()).filter(c=>typeof c==="string"||typeof c==="number").join(" ");
const gateway=(extra:Partial<Account>={}):Account=>({id:"gw",provider:"claude",source:"gateway",label:"Proxy",baseUrl:"https://gw.example/v1",email:null,plan:null,authStatus:"ready",createdAt:"2026-11-22",login:null,...extra});
function mount(account=gateway()){
  const props={account,theme:{colors:{}},host:{id:"host"},onChanged:vi.fn(),onClose:vi.fn()};
  return {props,render:()=>{fixture.render();return GatewayUsageForm(props as never);}};
}
beforeEach(()=>{fixture.reset();fixture.rpc.mockReset().mockResolvedValue({});fixture.runs.length=0;});

describe("usage form values",()=>{
  it("round-trips a saved endpoint setting",()=>{
    expect(usageFromForm(formFromUsage(BDDEV_USAGE),"https://api.bddevlab.online")).toEqual({ok:true,usage:BDDEV_USAGE});
    expect(usageFromForm(formFromUsage({kind:"file",path:"/data/report.json"}),"https://gw.example")).toEqual({ok:true,usage:{kind:"file",path:"/data/report.json"}});
    expect(usageFromForm(formFromUsage(undefined),"https://gw.example")).toEqual({ok:true,usage:null});
  });
  it("accepts a full address on the gateway and stores its path",()=>{
    const form={...formFromUsage(BDDEV_USAGE),path:"https://gw.example/api/usage?team=a"};
    expect(usageFromForm(form,"https://gw.example/v1")).toMatchObject({ok:true,usage:{path:"/api/usage?team=a"}});
  });
  it("refuses an address on another host, and values that do not fit",()=>{
    const form=formFromUsage(BDDEV_USAGE);
    expect(usageFromForm({...form,path:"https://other.example/api/usage"},"https://gw.example")).toEqual({ok:false,error:"The usage endpoint must be on the gateway (gw.example)."});
    expect(usageFromForm({...form,divisor:"0"},"https://gw.example").ok).toBe(false);
    expect(usageFromForm({...form,divisor:"abc"},"https://gw.example").ok).toBe(false);
    expect(usageFromForm({...form,used:"",limit:"",remaining:"",usedPercent:""},"https://gw.example").ok).toBe(false);
    expect(usageFromForm({...form,used:"a b"},"https://gw.example").ok).toBe(false);
    expect(usageFromForm({...formFromUsage({kind:"file",path:"/x"}),filePath:"relative.json"},"https://gw.example").ok).toBe(false);
  });
});

describe("usage form",()=>{
  it("offers the choices and starts on Off for a gateway without a reader",()=>{
    const {render}=mount();
    const kinds=choice(render(),"Usage");
    expect(kinds.props.options!.map(o=>o.label)).toEqual(["Off","Usage endpoint","Usage dashboard","External reading"]);
    expect(kinds.props.value).toBe("off");
    expect(button(render(),"Test")).toBeUndefined();
  });
  it("fills in BDDev's values, tests them and saves them",async()=>{
    const {render,props}=mount(gateway({baseUrl:"https://api.bddevlab.online"}));
    choice(render(),"Usage").props.onChange!("endpoint");
    button(render(),"Fill in for BDDev").props.onPress!();
    expect(field(render(),"Usage endpoint").props.value).toBe("/api/usage/token/");
    expect(field(render(),"Field for used").props.value).toBe("data.total_used");
    fixture.rpc.mockResolvedValueOnce({ok:true,plan:"Team",windows:[],balances:[{id:"balance",label:"Credits",used:588,remaining:412,limit:1000,unit:"credits",detail:null}],error:null});
    button(render(),"Test").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("claude.gateway-usage-test",{accountId:"gw",usage:BDDEV_USAGE});
    expect(text(render())).toContain("412 of 1,000 credits left");
    button(render(),"Save").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("claude.gateway-usage-set",{accountId:"gw",usage:BDDEV_USAGE});
    expect(props.onClose).toHaveBeenCalled();
  });
  it("shows the reason a test failed",async()=>{
    const {render}=mount(gateway({usage:BDDEV_USAGE}));
    fixture.rpc.mockResolvedValueOnce({ok:false,plan:null,windows:[],balances:[],error:"The gateway refused the token (401)."});
    button(render(),"Test").props.onPress!();
    await Promise.all(fixture.runs);
    expect(text(render())).toContain("The gateway refused the token (401).");
  });
  it("saves Off as no reader, and keeps Save disabled while the values do not fit",async()=>{
    const {render}=mount(gateway({usage:BDDEV_USAGE}));
    field(render(),"Divisor").props.onChangeText!("0");
    expect(button(render(),"Save").props.disabled).toBe(true);
    expect(button(render(),"Test").props.disabled).toBe(true);
    choice(render(),"Usage").props.onChange!("off");
    expect(button(render(),"Save").props.disabled).toBe(false);
    button(render(),"Save").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("claude.gateway-usage-set",{accountId:"gw",usage:null});
  });
  it("saves an external reading's path",async()=>{
    const {render}=mount();
    choice(render(),"Usage").props.onChange!("file");
    field(render(),"Usage file").props.onChangeText!("/data/usage/report.json");
    button(render(),"Save").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("claude.gateway-usage-set",{accountId:"gw",usage:{kind:"file",path:"/data/usage/report.json"}});
  });
});

describe("usage dashboard form",()=>{
  const saved={kind:"dashboard" as const,browser:{host:"browser.example",port:9223},pages:["https://gw.example/dashboard","https://gw.example/dashboard/users"],accountTile:"viewer@example.com",
    between:[{after:"team-a",before:"team-b"},{}],
    readings:[{label:"Weekly",find:"Weekly · all models",type:"percent" as const},{label:"Cost",find:"EST. COST",type:"amount" as const,unit:"usd" as const,page:1}]};
  it("round-trips a saved dashboard setting",()=>{
    expect(usageFromForm(formFromUsage(saved),"https://gw.example")).toEqual({ok:true,usage:saved});
    const simple={kind:"dashboard" as const,browser:{host:"127.0.0.1",port:9222},pages:["https://gw.example/dashboard"],readings:[{label:"Cost",find:"EST. COST",type:"amount" as const,unit:"credits" as const}]};
    expect(usageFromForm(formFromUsage(simple),"https://gw.example")).toEqual({ok:true,usage:simple});
  });
  it("starts with the shared browser's address, the gateway's address as the page and one empty reading",()=>{
    const {render}=mount();
    choice(render(),"Usage").props.onChange!("dashboard");
    expect(field(render(),"Browser host").props.value).toBe("127.0.0.1");
    expect(field(render(),"Browser port").props.value).toBe("9222");
    expect(field(render(),"Page 1 address").props.value).toBe("https://gw.example/");
    expect(field(render(),"Reading 1 caption").props.value).toBe("");
    expect(button(render(),"Save").props.disabled).toBe(true);
  });
  it("adds and removes pages and readings, and saves what it shows",async()=>{
    const {render}=mount();
    choice(render(),"Usage").props.onChange!("dashboard");
    field(render(),"Page 1 address").props.onChangeText!("https://gw.example/dashboard");
    button(render(),"Add page").props.onPress!();
    field(render(),"Page 2 address").props.onChangeText!("https://gw.example/dashboard/users");
    field(render(),"Reading 1 caption").props.onChangeText!("Weekly · all models");
    field(render(),"Reading 1 name").props.onChangeText!("Weekly");
    button(render(),"Add reading").props.onPress!();
    field(render(),"Reading 2 caption").props.onChangeText!("EST. COST");
    field(render(),"Reading 2 name").props.onChangeText!("Cost");
    choice(render(),"Reading 2 kind").props.onChange!("amount");
    choice(render(),"Reading 2 unit").props.onChange!("usd");
    choice(render(),"Reading 2 page").props.onChange!("1");
    button(render(),"Add reading").props.onPress!();
    expect(field(render(),"Reading 3 caption")).toBeDefined();
    elements(render()).find(e=>e.type===Button&&e.props.label==="Remove reading 3")!.props.onPress!();
    expect(field(render(),"Reading 3 caption")).toBeUndefined();
    button(render(),"Save").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("claude.gateway-usage-set",{accountId:"gw",usage:{kind:"dashboard",browser:{host:"127.0.0.1",port:9222},
      pages:["https://gw.example/dashboard","https://gw.example/dashboard/users"],
      readings:[{label:"Weekly",find:"Weekly · all models",type:"percent"},{label:"Cost",find:"EST. COST",type:"amount",unit:"usd",page:1}]}});
  });
  it("shows the page text after a test and fills the reading being edited from a chosen line",async()=>{
    const {render}=mount(gateway({usage:saved}));
    fixture.rpc.mockResolvedValueOnce({ok:false,plan:null,windows:[{id:"weekly",label:"Weekly",usedPercent:99,windowDurationMins:null,resetsAt:null}],balances:[],error:"No line 'EST. COST' on the page.",lines:[["Account limits","Weekly · all models","99%"],["My usage","ESTIMATED COST","$38.20"]]});
    button(render(),"Test").props.onPress!();
    await Promise.all(fixture.runs);
    expect(text(render())).toContain("No line 'EST. COST' on the page.");
    expect(text(render())).toContain("Weekly: 99% used");
    expect(text(render())).toContain("ESTIMATED COST");
    field(render(),"Reading 2 caption").props.onFocus!();
    elements(render()).find(e=>e.props.accessibilityLabel==="Use line: ESTIMATED COST")!.props.onPress!();
    expect(field(render(),"Reading 2 caption").props.value).toBe("ESTIMATED COST");
    expect(field(render(),"Reading 1 caption").props.value).toBe("Weekly · all models");
  });
  it("refuses values that do not fit",()=>{
    const form=formFromUsage(saved);
    expect(usageFromForm({...form,browserPort:"abc"},"https://gw.example").ok).toBe(false);
    expect(usageFromForm({...form,pages:["http://gw.example/dashboard"]},"https://gw.example").ok).toBe(false);
    expect(usageFromForm({...form,readings:[{label:"A",find:"",type:"percent",unit:"credits",page:0}]},"https://gw.example").ok).toBe(false);
  });
  it("tests a dashboard before any caption is known, to fetch the page text to pick from",async()=>{
    const {render}=mount();
    choice(render(),"Usage").props.onChange!("dashboard");
    field(render(),"Browser host").props.onChangeText!("browser.example");
    field(render(),"Page 1 address").props.onChangeText!("https://gw.example/dashboard");
    expect(button(render(),"Test").props.disabled).toBe(false);
    expect(button(render(),"Save").props.disabled).toBe(true);
    expect(text(render())).toContain("Enter a caption for reading 1. Press Test to see the page text and pick one.");
    expect(text(render())).not.toMatch(/Too small|expected string/);
    fixture.rpc.mockResolvedValueOnce({ok:true,plan:null,windows:[],balances:[],error:null,lines:[["Account limits","Weekly · all models","99%"]]});
    button(render(),"Test").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("claude.gateway-usage-test",{accountId:"gw",usage:{kind:"dashboard",browser:{host:"browser.example",port:9222},pages:["https://gw.example/dashboard"],readings:[]}});
    expect(text(render())).toContain("Weekly · all models");
    expect(text(render())).not.toContain("The reading is empty.");
    elements(render()).find(e=>e.props.accessibilityLabel==="Use line: Weekly · all models")!.props.onPress!();
    expect(field(render(),"Reading 1 caption").props.value).toBe("Weekly · all models");
    expect(button(render(),"Save").props.disabled).toBe(false);
    button(render(),"Save").props.onPress!();
    await Promise.all(fixture.runs);
    expect(fixture.rpc).toHaveBeenLastCalledWith("claude.gateway-usage-set",{accountId:"gw",usage:{kind:"dashboard",browser:{host:"browser.example",port:9222},pages:["https://gw.example/dashboard"],
      readings:[{label:"Weekly · all models",find:"Weekly · all models",type:"percent"}]}});
  });
  it("says what is missing in plain words",()=>{
    const form=formFromUsage(saved);
    expect(usageFromForm({...form,browserHost:""},"https://gw.example")).toEqual({ok:false,error:"Enter the browser’s host name or IP address."});
    expect(usageFromForm({...form,browserPort:"0"},"https://gw.example")).toEqual({ok:false,error:"Enter the browser’s port, a number from 1 to 65535."});
    expect(usageFromForm({...form,pages:["https://gw.example/dashboard","gw.example/users"]},"https://gw.example")).toEqual({ok:false,error:"Page 2 needs an https address."});
    expect(usageFromForm({...form,readings:[form.readings[0],{...form.readings[1],find:" "}]},"https://gw.example")).toEqual({ok:false,error:"Enter a caption for reading 2. Press Test to see the page text and pick one."});
    expect(usageFromForm({...form,readings:[form.readings[0],{...form.readings[1],find:" "}]},"https://gw.example","test")).toMatchObject({ok:true,usage:{readings:[{find:"Weekly · all models"}]}});
    expect(usageFromForm({...form,readings:[{...form.readings[0],label:""}]},"https://gw.example")).toMatchObject({ok:true,usage:{readings:[{label:"Weekly · all models"}]}});
    expect(usageFromForm({...form,readings:[{...form.readings[0],label:"",find:"x".repeat(60)}]},"https://gw.example")).toMatchObject({ok:true,usage:{readings:[{label:"x".repeat(40)}]}});
  });
});
