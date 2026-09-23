// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import {expect,type Page} from "@playwright/test";
import {test} from "./helpers/e2e.ts";
import {apiBaseUrl,authorizationHeader} from "./e2e-auth.js";
import {artifactTree,cleanupJourney,createProjectAndSession,openProjectSession,scriptedModel,sendUserMessage,waitForRunTerminal} from "./helpers/journeys.ts";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("journey-plugin-composition.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64", "@model:mock", "@sandbox:bubblewrap"] }, () => {

async function api(page:Page,path:string,data?:unknown) {
  const response=await page.request.fetch(apiBaseUrl()+path,{headers:authorizationHeader(),method:data===undefined?"GET":"POST",...(data===undefined?{}:{data})});
  expect(response.ok(),await response.text()).toBe(true);
  return response.json();
}
/**
 * E2E-META
 * Purpose: Project plugin configuration affects the next Run, Session overrides restore a capability, and an approved experiment is applied without altering unrelated settings.
 * Steps:
 *   0. Disable PubMed through scoped configuration and verify the Composer hides it; restoring it refreshes the open picker without a reload.
 *   1. Configure internal plugins through the API; Project settings only expose optional extensions and preserve hidden configuration on desktop and narrow screens.
 *   2. Complete a Run without disabled tools; restore Plan through the Session API and see a real Plan card after reload.
 *   3. Prepare a fixed candidate and complete the same task in baseline and candidate Sessions.
 *   4. Compare, approve and apply the candidate; rejected candidates do not change active settings.
 *   5. Open a JSON artifact and enable its viewer without reload through the scoped subscription.
 * Environment: Isolated API/Web and Runner at E2E_BASE_URL; ordinary Sessions and catalog persistence.
 * Type: mocked
 * LLM: journey-owned HTTP stub on 127.0.0.1, capturing actual offered tool names.
 * WebSearch: none
 * PaperSources: none
 * MCP: none; disabled capability is verified without network calls.
 * OtherExternal: none
 * Credentials: E2E_API_TOKEN for the isolated local API only.
 * CostSideEffects: no external cost; journey-owned Project and model are removed in finally.
 */
test("项目组合、会话覆盖与审批后的候选应用", {tag:"@mocked"},async({page,journey})=>{
  test.setTimeout(180_000);
  journey.scenario({goal:"研究员只在界面管理可选扩展；后端仍支持项目独立插件组合、会话覆盖和审批应用，保存界面不会重置隐藏配置。",
    preconditions:["真实隔离 API/Runner 已启动","本地模型 stub，不调用外部服务；实验只执行模型回复及 Plan 更新"]});
  // The journeys run on JiuwenSwarm's own tools (.ci/run-e2e.sh): the Plan plugin's tool is its todo list, not update_plan.
  const planTool="todo_create";
  const stub=await scriptedModel([
    [{text:"Reduced composition completed."}],
    [{tool:"todo_create",arguments:{call_goal:"Verify restored planning",tasks:[{id:"verify",content:"Verify restored planning",activeForm:"Verifying restored planning",description:"Check the Plan tools are back."}]}},
      {tool:"todo_modify",arguments:{action:"update",todos:[{id:"verify",status:"completed"}]}},{text:"Planning restored."}],
    [{text:"Baseline experiment completed."}],
    [{text:"Candidate experiment completed."}],
  ]);
  const fixture=await createProjectAndSession(page,{model:{apiToken:stub.apiToken,baseUrl:stub.baseUrl,model:stub.model,name:"Plugin model "+Date.now()},
    projectName:"Plugin project "+Date.now(),sessionTitle:"Plugin configuration"});
  const root="/api/projects/"+fixture.project.id+"/plugins";
  let otherProjectId:string|undefined;
  const openSettings=async(kind:"project"|"session")=>{
    await page.goto(`/projects/${fixture.project.id}${kind==="session"?"/sessions/"+fixture.session.id:""}/settings`);
    const dialog=page.getByRole("dialog",{name:kind==="project"?/Project settings|项目设置/:/Session settings|会话设置/});
    await expect(dialog).toBeVisible();await dialog.locator("details.plugin-settings > summary").click();return dialog;
  };
  try {
    await journey.step("连接器选择与项目插件配置一致","关闭 PubMed 后不能勾选它，UniProt 仍可选；恢复后无须刷新即可重新选择 PubMed。",async()=>{
      const configure=async(enabled:boolean)=>{
        const baseline=await api(page,root);
        await api(page,root+"/bridge",{apiVersion:1,pluginId:"host.settings",scope:{projectId:fixture.project.id},kind:"command",method:"replace",
          input:{expectedRevision:baseline.revision,overrides:{...baseline.settings.overrides,plugins:{"connector.pubmed":{enabled}}}}});
      };
      await configure(false);
      await openProjectSession(page,fixture);
      await page.locator(".connector-picker-trigger").click();
      const picker=page.locator(".connector-picker-popover");
      await expect(picker.getByRole("checkbox",{name:/UniProt/})).toBeVisible();
      await expect(picker.getByRole("checkbox",{name:/PubMed/})).toHaveCount(0);
      await configure(true);
      await expect(picker.getByRole("checkbox",{name:/PubMed/})).toBeVisible();
      const pubmed=picker.getByRole("checkbox",{name:/PubMed/});
      // Selection is persisted by the API before the controlled input updates.
      if (!await pubmed.isChecked()) await pubmed.click();
      await expect(pubmed).toBeChecked();
    });
    await journey.step("管理可选扩展而不改动内部插件组合","界面仅有 JSON 预览开关；保存后保留 API 配置的内部和数据源插件关闭项，其他项目不受影响。",async()=>{
      const baseline=await api(page,root);
      await api(page,root+"/bridge",{apiVersion:1,pluginId:"host.settings",scope:{projectId:fixture.project.id},kind:"command",method:"replace",
        input:{expectedRevision:baseline.revision,overrides:{...baseline.settings.overrides,plugins:Object.fromEntries(["plan","skill","mcp","scheduler","connector.uniprot","connector.pubmed"].map(id=>[id,{enabled:false}]))}}});
      const other=await api(page,"/api/projects",{name:"Independent plugins "+Date.now()});
      otherProjectId=other.project.id;
      const dialog=await openSettings("project");
      for(const id of ["plan","skill","mcp","scheduler","connector.uniprot","connector.pubmed"]) await expect(dialog.getByLabel(id+" plugin",{exact:true})).toHaveCount(0);
      await dialog.getByLabel("artifact-json plugin",{exact:true}).selectOption("disabled");
      await dialog.getByRole("button",{name:/Save .*settings|保存.*设置/}).click();
      await expect.poll(async()=> (await api(page,root)).settings.effective.plugins.plan.enabled).toBe(false);
      await page.reload();
      await page.locator("details.plugin-settings > summary").click();
      await expect(page.getByLabel("connector.uniprot plugin",{exact:true})).toHaveCount(0);
      await expect(page.getByLabel("artifact-json plugin",{exact:true})).toHaveValue("disabled");
      await expect(page.getByText(/Existing configuration disables|已有配置关闭了内置能力/)).toBeVisible();
      const current=await api(page,root),independent=await api(page,"/api/projects/"+otherProjectId+"/plugins");
      for(const id of ["plan","skill","mcp","scheduler","connector.uniprot","connector.pubmed"]){
        expect(current.settings.effective.plugins[id].enabled).toBe(false);
        expect(independent.settings.effective.plugins?.[id]?.enabled).not.toBe(false);
      }
    });
    await journey.step("窄屏查看项目可选扩展","JSON 预览开关及内部配置提示可读，没有水平溢出。",async()=>{
      await page.setViewportSize({width:390,height:844});
      await page.getByLabel("artifact-json plugin",{exact:true}).scrollIntoViewIfNeeded();
      await expect(page.getByLabel("artifact-json plugin",{exact:true})).toBeVisible();
      expect(await page.locator(".plugin-settings").evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    });
    await journey.step("执行后端按项目裁剪的组合","下一次实际模型调用没有 Plan、Skill、MCP 或调度工具。",async()=>{
      await page.setViewportSize({width:1440,height:1000});
      await openProjectSession(page,fixture);
      const run=await sendUserMessage(page,fixture.session.id,"Complete this task without optional capabilities.");
      expect((await waitForRunTerminal(page,fixture.session.id,run.id)).status).toBe("completed");
      const tools=stub.calls.filter(call=>call.turn===0).flatMap(call=>call.offeredTools??[]);
      expect(tools).not.toContain(planTool);expect(tools).not.toContain("read_skill");expect(tools).not.toContain("task");
      expect(tools.some(name=>name.startsWith("mcp"))).toBe(false);
      await expect(page.getByText("Reduced composition completed.",{exact:true}).first()).toBeVisible();
    });
    await journey.step("只在当前会话恢复 Plan","会话的覆盖重新提供 Plan 工具；真实 Plan 卡片在刷新后仍可查看。",async()=>{
      const scope={projectId:fixture.project.id,sessionId:fixture.session.id};
      const current=await api(page,root+"?sessionId="+fixture.session.id);
      await api(page,root+"/bridge?sessionId="+fixture.session.id,{apiVersion:1,pluginId:"plan",scope,kind:"command",method:"configure",
        input:{expectedRevision:current.revision,settings:{enabled:true}}});
      await expect.poll(async()=> (await api(page,root+"?sessionId="+fixture.session.id)).settings.effective.plugins.plan.enabled).toBe(true);
      await openProjectSession(page,fixture);
      const run=await sendUserMessage(page,fixture.session.id,"Track verification with a Plan.");
      expect((await waitForRunTerminal(page,fixture.session.id,run.id)).status).toBe("completed");
      expect(stub.calls.filter(call=>call.turn===1).some(call=>call.offeredTools?.includes(planTool))).toBe(true);
      const state=await api(page,root+"/bridge?sessionId="+fixture.session.id,{apiVersion:1,pluginId:"plan",
        scope:{projectId:fixture.project.id,sessionId:fixture.session.id},kind:"query",method:"state",input:{runId:run.id}});
      expect(state.result.length).toBeGreaterThan(0);
      await page.reload();
      const workspace=page.locator("aside.workspace-panel");
      if (!await workspace.count()) await page.getByRole("button",{name:/Show workspace|显示工作区/}).click();
      const folder=workspace.locator('[data-folder="tasks"]');
      if (await folder.getAttribute("open")===null) await folder.locator(":scope > summary").click();
      const plans=workspace.locator("details.workspace-plan-section");
      if (await plans.getAttribute("open")===null) await plans.locator(":scope > summary").click();
      await expect(page.locator("article.plan-card").first()).toBeVisible();
    });
    let candidate:any,baselineRunId="",candidateRunId="";
    await journey.step("固定基线并分别运行两个实验","两个普通实验会话完成相同任务，只有候选组合包含 Plan；原项目组合未被提前修改。",async()=>{
      // Project model configuration is explicit; the fixture originally selected the Session model.
      const composition=await api(page,root);
      await api(page,root+"/bridge",{apiVersion:1,pluginId:"host.settings",scope:{projectId:fixture.project.id},kind:"command",method:"replace",
        input:{expectedRevision:composition.revision,overrides:{...composition.settings.overrides,modelId:fixture.model!.id}}});
      const baseline=await api(page,root);
      candidate=await api(page,root+"/candidates",{expectedRevision:baseline.revision,patch:{plugins:{plan:{enabled:true}}}});
      expect(candidate.baselineRef.digest).toMatch(/^sha256:/);expect(candidate.proposedRef.digest).toMatch(/^sha256:/);
      candidate=await api(page,root+"/candidates/"+candidate.id+"/prepare",{});
      for(const [name,sessionId] of [["baseline",candidate.experiments.baselineSessionId],["candidate",candidate.experiments.candidateSessionId]]) {
        const session=await api(page,"/api/sessions/"+sessionId);
        await openProjectSession(page,{...fixture,session});
        const run=await sendUserMessage(page,sessionId,"Perform the same bounded experiment.");
        expect((await waitForRunTerminal(page,sessionId,run.id)).status).toBe("completed");
        if(name==="baseline")baselineRunId=run.id;else candidateRunId=run.id;
      }
      expect(stub.calls.filter(call=>call.turn===2).some(call=>call.offeredTools?.includes(planTool))).toBe(false);
      expect(stub.calls.filter(call=>call.turn===3).some(call=>call.offeredTools?.includes(planTool))).toBe(true);
      expect((await api(page,root)).settings.effective.plugins.plan.enabled).toBe(false);
      await expect(page.getByText("Candidate experiment completed.",{exact:true}).first()).toBeVisible();
    });
    await journey.step("比较、审批并应用；拒绝另一个候选","独立审批后项目采用候选 Plan 设置，其他关闭项保持不变；拒绝不改变活动版本。",async()=>{
      const compared=await api(page,root+"/candidates/"+candidate.id+"/compare",{baselineRunId,candidateRunId});
      expect(compared.comparisonRef.digest).toMatch(/^sha256:/);
      const denied=await page.request.post(apiBaseUrl()+root+"/candidates/"+candidate.id+"/apply",{headers:authorizationHeader(),data:{}});
      expect(denied.status()).toBe(409);
      await api(page,root+"/candidates/"+candidate.id+"/approve",{});
      const applied=await api(page,root+"/candidates/"+candidate.id+"/apply",{});
      expect(applied.status).toBe("applied");
      const active=await api(page,root);
      expect(active.settings.effective.plugins.plan.enabled).toBe(true);expect(active.settings.effective.plugins.skill.enabled).toBe(false);
      const rejected=await api(page,root+"/candidates",{expectedRevision:active.revision,patch:{plugins:{mcp:{enabled:true}}}});
      await api(page,root+"/candidates/"+rejected.id+"/reject",{});
      expect((await api(page,root)).revision).toBe(active.revision);
      const dialog=await openSettings("project");
      await expect(dialog.getByLabel("plan plugin",{exact:true})).toHaveCount(0);
      await expect(dialog.getByLabel("skill plugin",{exact:true})).toHaveCount(0);
      const notice=dialog.getByText(/Existing configuration disables|已有配置关闭了内置能力/);
      await expect(notice).toContainText("skill");
      await expect(notice).not.toContainText("plan");
    });
    await journey.step("独立启停 JSON 查看器","关闭时保留原始内容；启用后经作用域订阅切换到插件预览，不重新运行任务也不丢失产物。",async()=>{
      await api(page,"/api/sessions/"+fixture.session.id+"/files",{path:"plugin-preview.json",content:JSON.stringify({message:"Plugin preview remains readable"})});
      await openProjectSession(page,fixture);
      const tree=await artifactTree(page);
      await tree.catalog.getByRole("button",{name:"Open plugin-preview.json"}).click();
      const modal=page.getByRole("dialog",{name:"Artifact: plugin-preview.json"});
      await expect(modal.locator("pre.artifact-source-preview")).toContainText("Plugin preview remains readable");
      await expect(modal.locator(".json-source-preview")).toHaveCount(0);
      const active=await api(page,root);
      await api(page,root+"/bridge",{apiVersion:1,pluginId:"artifact-json",scope:{projectId:fixture.project.id},kind:"command",method:"configure",
        input:{expectedRevision:active.revision,settings:{enabled:true}}});
      await expect(modal.locator(".json-source-preview")).toBeVisible();
      await expect(modal.locator("pre.artifact-source-preview")).toContainText("Plugin preview remains readable");
    });
  } finally {
    if(otherProjectId) await page.request.delete(apiBaseUrl()+"/api/projects/"+otherProjectId,{headers:authorizationHeader()});
    await cleanupJourney(page,fixture).catch(()=>undefined);await stub.stop();
  }
});

});
