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

type Node=ReactElement<{children?:unknown;label?:string;disabled?:boolean;onPress?():void;accessibilityLabel?:string;onChangeText?(text:string):void;value?:string;onChange?(value:string):void;options?:{value:string;label:string}[]}>;
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
    expect(kinds.props.options!.map(o=>o.label)).toEqual(["Off","Usage endpoint","External reading"]);
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
