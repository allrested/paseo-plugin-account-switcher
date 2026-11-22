import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountController } from "../server/controller";
import { UsageError } from "../server/usage";
import { addGateway, setGatewayUsage } from "../server/claude-profiles";

const boundary=vi.hoisted(()=>({fetch:vi.fn(),probe:vi.fn()}));
// Renewal reads real credentials; these tests use the real system Claude home.
vi.mock("../server/usage/claude",async original=>({...await original<typeof import("../server/usage/claude")>(),renewExpiredClaudeToken:vi.fn(async()=>false)}));
vi.mock("../server/auth",async original=>({...await original<typeof import("../server/auth")>(),probeAccount:boundary.probe}));
vi.mock("../server/usage",async original=>{
  const actual=await original<typeof import("../server/usage")>();
  return {...actual,readCredentialVersion:vi.fn(async()=>"present:fixture"),createUsageService:(options:Parameters<typeof actual.createUsageService>[0])=>{
    const service=actual.createUsageService({...options,fetchUsage:boundary.fetch});
    return {...service,start:vi.fn()};
  }};
});
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const identity={identityKey:"fixture-identity",email:null,plan:null,authStatus:"ready" as const};
const result={identityKey:identity.identityKey,plan:"max",windows:[{id:"five_hour",label:"5 hours",usedPercent:23,windowDurationMins:300,resetsAt:null}]};

describe("controller quota verification",()=>{
  it("allows fresh unknown-identity quota data without saving it",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-unknown-controller-"));roots.push(root);
    boundary.probe.mockResolvedValue({...identity,identityKey:null,authStatus:"unknown"});boundary.fetch.mockResolvedValue(result);
    const controller=new AccountController(root);await controller.ready;
    try {
      await controller.store.change(state=>{state.commands.codex=[process.execPath];});
      expect((await controller.usage.refresh("system-codex"))[0]).toMatchObject({status:"ok",windows:result.windows});
      expect(JSON.parse(await readFile(join(root,"usage-cache.json"),"utf8")).entries).toEqual([]);
    } finally {await controller.close();}
  });
  it("stages a cold-start cache until identity proof, then restores stale data on collector failure",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-restart-"));roots.push(root);
    boundary.probe.mockResolvedValue(identity);boundary.fetch.mockResolvedValue(result);
    const first=new AccountController(root);await first.ready;
    await first.store.change(state=>{state.commands.claude=[process.execPath];});
    expect((await first.usage.refresh("system-claude"))[0]).toMatchObject({status:"ok",windows:result.windows});
    await first.close();
    const restarted=new AccountController(root);await restarted.ready;
    try {
      expect((await restarted.usage.list())[0]?.windows).toEqual([]);
      expect(JSON.parse(await readFile(join(root,"usage-cache.json"),"utf8")).entries).toHaveLength(1);
      boundary.fetch.mockRejectedValue(new UsageError("unavailable","network"));
      const snapshot=(await restarted.usage.refresh("system-claude"))[0];
      expect(snapshot).toMatchObject({status:"stale",windows:result.windows});
    } finally {await restarted.close();}
  });
});

describe("gateways with a usage reader",()=>{
  const usage={kind:"endpoint" as const,path:"/usage",fields:{remaining:"left"},unit:"credits" as const,divisor:1,label:"Credits"};
  it("joins the scheduler with a fixed identity and without credential probes, even when the Claude CLI is missing",async()=>{
    const root=await mkdtemp(join(tmpdir(),"quota-gateway-"));roots.push(root);
    const controller=new AccountController(root);await controller.ready;
    try {
      await controller.store.change(state=>{state.available.claude=true;});
      const plain=await addGateway(controller.store,{label:"Plain",base_url:"https://plain.example",api_token:"fixture-a"});
      const read=await addGateway(controller.store,{label:"Read",base_url:"https://read.example/v1",api_token:"fixture-b"});
      await setGatewayUsage(controller.store,read.id,usage);
      await controller.store.change(state=>{state.available.claude=false;state.commands.claude=null;});
      boundary.probe.mockClear();
      const accounts=await controller.quotaAccounts({verifyAccountId:read.id});
      const quota=accounts.find(a=>a.id===read.id)!;
      expect(accounts.map(a=>a.id)).not.toContain(plain.id);
      expect(quota).toMatchObject({provider:"claude",identityKey:"gateway:"+read.id,command:[],gateway:{usage}});
      expect(quota.requireIdentityVerification).toBeFalsy();
      expect(await quota.gateway!.credentials()).toEqual({baseUrl:"https://read.example/v1",token:"fixture-b"});
      expect(boundary.probe).not.toHaveBeenCalled();
      boundary.fetch.mockResolvedValue({identityKey:null,plan:null,windows:[],balances:[{id:"balance",label:"Credits",used:null,remaining:412,limit:null,unit:"credits",detail:null}]});
      expect((await controller.usage.refresh(read.id)).find(s=>s.accountId===read.id)).toMatchObject({status:"ok",balances:[{remaining:412}]});
    } finally {await controller.close();}
  });
});
