import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { AccountStore } from "../server/store";
import { addGateway, discoverProfiles, gatewayArguments, linkProfile, rotateGateway, gatewayEnvironment, setGatewayUsage, testGatewayUsage, discoverGatewayProviders, importGatewayProvider } from "../server/claude-profiles";
import { launcherPath, writeLaunchers } from "../server/integration";
import { accountEnvironment } from "../server/auth";
import { AccountController } from "../server/controller";
import { SwitchService } from "../server/switching";
import { BDDEV_USAGE, GatewayInput } from "../shared/contracts";
import { defaultCommands } from "../client/command";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{force:true,recursive:true})));});
async function fixture(){
  const home=await mkdtemp(join(tmpdir(),"account-gateway-")); roots.push(home);
  const store=new AccountStore(join(home,"plugin"));
  await store.initialize({claude:join(home,".claude"),codex:join(home,".codex")});
  return {home,store};
}
it("lists compatible local profiles, links once and forgets without changing their files",async()=>{
  const {home,store}=await fixture();
  const external=join(home,".claude-work");
  await mkdir(external); await mkdir(join(home,".claude-proxy")); await symlink(external,join(home,".claude-alias"));
  await writeFile(join(home,".claude-proxy","settings.json"), JSON.stringify({env:{ANTHROPIC_BASE_URL:"https://example.test"}}));
  await writeFile(join(external,"keep"),"preserved");
  expect(await discoverProfiles(store,home)).toEqual([".claude-work"]);
  await expect(linkProfile(store,"../elsewhere",home)).rejects.toThrow();
  const [a,b]=await Promise.all([linkProfile(store,".claude-work",home),linkProfile(store,".claude-work",home)]);
  expect(a.id).toBe(b.id);expect(a.source).toBe("linked");expect(await discoverProfiles(store,home)).toEqual([]);
  const registry=await store.read(), linked=registry.accounts.find(entry=>entry.id===a.id)!;
  const env=accountEnvironment(linked,registry,{ANTHROPIC_AUTH_TOKEN:"unrelated"});
  expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(external);
  expect(env.CLAUDE_CONFIG_DIR).toBe(join(store.root,"accounts",a.id,"claude"));
  expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  const controller=new AccountController(store.root);
  try {await controller.remove(a.id);} finally {await controller.close();}
  expect(await readFile(join(external,"keep"),"utf8")).toBe("preserved");
});
it("rejects unsafe public endpoints and header text",()=>{
  for(const base_url of ["http://example.test","https://user:pass@example.test","https://example.test/?token=secret","file:///tmp/foo"]){
    expect(GatewayInput.safeParse({label:"Gateway",base_url,api_token:"test-only"}).success).toBe(false);
  }
  expect(GatewayInput.safeParse({label:"Gateway",base_url:"https://example.test",api_token:"bad\nheader"}).success).toBe(false);
});
it("preserves SDK permission settings when pinning the gateway endpoint", async()=>{
  const {store}=await fixture();
  const pinned=await gatewayArguments(store.root,["--settings",JSON.stringify({permissions:{deny:["Bash"]},env:{FLAG:"on"}})],"https://example.test");
  expect(JSON.parse(await readFile(pinned.file!,"utf8"))).toEqual({permissions:{deny:["Bash"]},env:{FLAG:"on",ANTHROPIC_BASE_URL:"https://example.test"}});
});
it("sends the synthetic bearer only from the explicitly bound launcher and excludes it from subscription selection and usage",async()=>{
  const {home,store}=await fixture(), token="only-a-test-bearer";
  const requests:unknown[]=[];
  const http=createServer((req,res)=>{requests.push([req.url,req.headers.authorization]); res.end("ok");});
  await new Promise<void>(done=>http.listen(0,"127.0.0.1",done));
  const address=http.address(); if(!address || typeof address==="string")throw Error("No port");
  const base_url="http://127.0.0.1:"+address.port+"/gateway";
  const controller=new AccountController(store.root);
  try {
    await controller.ready;
    const cli=join(home,"fake-claude.cjs");
    await writeFile(cli,`
      (async()=>{
        if(process.env.ANTHROPIC_AUTH_TOKEN){
          if(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.argv.join(" ").includes(process.env.ANTHROPIC_AUTH_TOKEN))process.exit(42);
          const response=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{Authorization:"Bearer "+process.env.ANTHROPIC_AUTH_TOKEN}});
          if(!response.ok)process.exit(43);
        }
      })().catch(()=>process.exit(44));`);
    await store.change(s=>{s.commands.claude=[process.execPath,cli];s.integration.enabled=true;s.defaults.claude="system-claude";s.preferHeadroom=true;});
    const gateway=await addGateway(store,{label:"Proxy",base_url,api_token:token});
    expect(JSON.stringify(await store.snapshot())).not.toContain(token);
    expect(await readFile(join(store.root,"registry.json"),"utf8")).not.toContain(token);
    const file=join(store.root,"accounts",gateway.id,"gateway.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await controller.quotaAccounts()).map(a=>a.id)).not.toContain(gateway.id);
    expect(defaultCommands(await store.snapshot()).map(c=>c.accountId)).not.toContain(gateway.id);
    await expect(controller.setDefault("claude",gateway.id)).rejects.toThrow(/explicit/);
    const service=new SwitchService({store,inspect:async()=>({provider:"claude",busy:false,archived:false}),reload:async()=>{},checkAccount:async id=>({authStatus:id===gateway.id?"ready":"needs_auth"})});
    await expect(service.bindNewAgent("automatic","claude")).rejects.toThrow(/authentication/);
    await service.bindNewAgent("explicit","claude",null,gateway.id);
    await writeLaunchers(store);
    const run=promisify(execFile);
    const result=await run(launcherPath(store.root,"claude"),[],{env:{...process.env,PASEO_AGENT_ID:"explicit",CLAUDE_CODE_OAUTH_TOKEN:"test-oauth",ANTHROPIC_API_KEY:"test-key"}});
    expect(result.stdout+result.stderr).not.toContain(token);
    await run(launcherPath(store.root,"claude"),[],{env:{...process.env,PASEO_AGENT_ID:"another-agent"}});
    expect(requests).toEqual([["/gateway/v1/messages","Bearer "+token]]);
    await rotateGateway(store,gateway.id,"replacement-fixture");
    const saved=(await store.read()).accounts.find(a=>a.id===gateway.id)!;
    expect((await gatewayEnvironment(store.root,saved)).ANTHROPIC_AUTH_TOKEN).toBe("replacement-fixture");
    expect(JSON.stringify(await store.snapshot())).not.toContain("replacement-fixture");
    await rm(file);
    await expect(run(launcherPath(store.root,"claude"),[],{env:{...process.env,PASEO_AGENT_ID:"explicit"}})).rejects.toThrow(/launcher failed/);
    expect(requests).toHaveLength(1);
  } finally {await controller.close(); await new Promise<void>(done=>http.close(()=>done()));}
});
it("saves, clears and tests a gateway's usage reader without exposing the token",async()=>{
  const {store}=await fixture(), token="only-a-test-bearer";
  const seen:unknown[]=[]; let status=200;
  const http=createServer((req,res)=>{seen.push([req.url,req.headers.authorization]);res.statusCode=status;res.end(JSON.stringify({data:{name:"Team",total_granted:100000000,total_used:58800000,total_available:41200000,unlimited_quota:false}}));});
  await new Promise<void>(done=>http.listen(0,"127.0.0.1",done));
  const address=http.address(); if(!address || typeof address==="string")throw Error("No port");
  try {
    await store.change(s=>{s.available.claude=true;});
    const gateway=await addGateway(store,{label:"Proxy",base_url:"http://127.0.0.1:"+address.port+"/gateway",api_token:token});
    const tested=await testGatewayUsage(store,gateway.id,BDDEV_USAGE);
    expect(tested).toEqual({ok:true,plan:"Team",windows:[],balances:[{id:"balance",label:"Credits",used:588,remaining:412,limit:1000,unit:"credits",detail:null}],error:null});
    expect(seen).toEqual([["/api/usage/token/","Bearer "+token]]);
    expect((await store.read()).accounts.find(a=>a.id===gateway.id)!.usage).toBeUndefined();
    status=401;
    const refused=await testGatewayUsage(store,gateway.id,BDDEV_USAGE);
    expect(refused).toEqual({ok:false,plan:null,windows:[],balances:[],error:"The gateway refused the token (401)."});
    expect(JSON.stringify([tested,refused])).not.toContain(token);
    await setGatewayUsage(store,gateway.id,BDDEV_USAGE);
    expect((await store.read()).accounts.find(a=>a.id===gateway.id)!.usage).toEqual(BDDEV_USAGE);
    expect((await store.snapshot()).accounts.find(a=>a.id===gateway.id)!.usage).toEqual(BDDEV_USAGE);
    await setGatewayUsage(store,gateway.id,null);
    expect((await store.read()).accounts.find(a=>a.id===gateway.id)!.usage).toBeUndefined();
    await expect(setGatewayUsage(store,"system-claude",BDDEV_USAGE)).rejects.toThrow("Choose a Claude gateway.");
    await expect(testGatewayUsage(store,"system-claude",BDDEV_USAGE)).rejects.toThrow("Choose a Claude gateway.");
  } finally {await new Promise(done=>http.close(done));}
});
it("tests a usage dashboard through the browser seam, returning the page text and whatever was found",async()=>{
  const {store}=await fixture();
  await store.change(s=>{s.available.claude=true;});
  const gateway=await addGateway(store,{label:"Proxy",base_url:"https://gateway.example",api_token:"only-a-test-bearer"});
  const page="Usage\n\nEST. COST\n\n$38.20\n";
  const openTab=()=>async()=>({navigate:async()=>{},close:async()=>{},evaluate:async(expression:string)=>expression.includes("location.href")?JSON.stringify({href:"https://gateway.example/dashboard",ready:"complete"}):expression.includes("innerText")?page:undefined});
  const usage={kind:"dashboard" as const,browser:{host:"browser.example",port:9222},pages:["https://gateway.example/dashboard"],readings:[{label:"Cost",find:"est. cost",type:"amount" as const,unit:"usd" as const}]};
  const found=await testGatewayUsage(store,gateway.id,usage,{openTab,sleep:async()=>{}});
  expect(found).toEqual({ok:true,plan:null,windows:[],balances:[{id:"cost",label:"Cost",used:38.2,remaining:null,limit:null,unit:"usd",detail:null}],error:null,lines:[["Usage","EST. COST","$38.20"]]});
  const partial=await testGatewayUsage(store,gateway.id,{...usage,readings:[...usage.readings,{label:"Gone",find:"NOT THERE",type:"percent" as const}]},{openTab,sleep:async()=>{}});
  expect(partial).toMatchObject({ok:false,error:"No line 'NOT THERE' on the page.",balances:[{used:38.2}],lines:[["Usage","EST. COST","$38.20"]]});
  expect(JSON.stringify([found,partial])).not.toContain("only-a-test-bearer");
});
it("offers Paseo's custom Claude providers as gateways and imports one without showing its token",async()=>{
  const {home,store}=await fixture(), token="only-a-test-bearer";
  const config=join(home,"config.json");
  await writeFile(config,JSON.stringify({agents:{providers:{
    "claude-api":{extends:"claude",label:"Claude (Proxy)",env:{ANTHROPIC_BASE_URL:"https://proxy.example/",ANTHROPIC_AUTH_TOKEN:token,ANTHROPIC_DEFAULT_OPUS_MODEL:"x",CLAUDE_CONFIG_DIR:"/home/u/.claude-api"}},
    "claude-work":{extends:"claude",env:{CLAUDE_CONFIG_DIR:"/home/u/.claude-work"}},
    "claude-key":{extends:"claude",env:{ANTHROPIC_BASE_URL:"https://key.example",ANTHROPIC_API_KEY:"x-api-key-only"}},
    "claude-http":{extends:"claude",env:{ANTHROPIC_BASE_URL:"http://insecure.example",ANTHROPIC_AUTH_TOKEN:"t"}},
    "other":{extends:"acp",env:{ANTHROPIC_BASE_URL:"https://acp.example",ANTHROPIC_AUTH_TOKEN:"t"}},
    codex:{},
  }}}));
  await store.change(s=>{s.available.claude=true;});
  const offered=await discoverGatewayProviders(store,config);
  expect(offered).toEqual([{provider:"claude-api",label:"Claude (Proxy)",baseUrl:"https://proxy.example"}]);
  expect(JSON.stringify(offered)).not.toContain(token);
  await expect(importGatewayProvider(store,config,"claude-work")).rejects.toThrow("This provider has no gateway to import.");
  await expect(importGatewayProvider(store,config,"missing")).rejects.toThrow("This provider has no gateway to import.");
  const account=await importGatewayProvider(store,config,"claude-api");
  expect(account).toMatchObject({source:"gateway",label:"Claude (Proxy)",baseUrl:"https://proxy.example",authStatus:"ready"});
  expect(JSON.stringify(account)).not.toContain(token);
  const saved=(await store.read()).accounts.find(a=>a.id===account.id)!;
  expect((await gatewayEnvironment(store.root,saved)).ANTHROPIC_AUTH_TOKEN).toBe(token);
  expect(await discoverGatewayProviders(store,config)).toEqual([]);
  await expect(importGatewayProvider(store,config,"claude-api")).rejects.toThrow("This gateway is already in Accounts.");
  expect(JSON.parse(await readFile(config,"utf8")).agents.providers["claude-api"].env.ANTHROPIC_AUTH_TOKEN).toBe(token);
  expect(await discoverGatewayProviders(store,join(home,"none.json"))).toEqual([]);
  await writeFile(config,"not json");
  expect(await discoverGatewayProviders(store,config)).toEqual([]);
});
