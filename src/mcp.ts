import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Runtime } from './runtime.js';

export async function serveMcp(root: string, agentId: string) {
  const runtime = new Runtime(root);
  if (!runtime.plan.agents.some(a => a.id === agentId)) throw new Error(`Unknown AgentMesh agent: ${agentId}`);
  const server = new McpServer({ name: 'agentmesh', version: '0.1.0' });
  const tool = (name: string, description: string, shape: Record<string, z.ZodTypeAny>, fn: (args: any) => unknown) => {
    server.tool(name, description, shape, async args => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(args)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String(error) }] }; }
    });
  };
  tool('get_project_context', 'Get concise project and phase context', {}, () => ({ projectType: runtime.plan.projectType, phase: runtime.state.phase(runtime.current().id), agentId }));
  tool('get_collaboration_plan', 'Read versioned collaboration plan', {}, () => runtime.plan);
  tool('get_current_phase', 'Read current phase', {}, () => runtime.current());
  tool('get_my_task', 'Read tasks assigned to this agent', {}, () => runtime.getTask(agentId));
  tool('list_tasks', 'List current phase tasks and status', {}, () => runtime.state.tasks(runtime.current().id));
  tool('get_task', 'Get a current task', { taskId: z.string() }, ({ taskId }) => runtime.state.tasks(runtime.current().id).find(t => t.id === taskId) ?? null);
  tool('get_contracts', 'Read frozen contract paths', {}, () => runtime.current().contracts);
  tool('update_task', 'Update own task status', { taskId: z.string(), status: z.enum(['pending', 'working', 'blocked']) }, ({ taskId, status }) => runtime.updateTask(agentId, taskId, status));
  tool('report_blocker', 'Report an exceptional blocker', { body: z.string() }, ({ body }) => runtime.report(agentId, 'blocker', body));
  tool('report_contract_conflict', 'Report frozen contract conflict', { body: z.string() }, ({ body }) => runtime.report(agentId, 'contract_conflict', body));
  tool('submit_checkpoint', 'Submit committed work for checkpoint', { taskId: z.string(), summary: z.string(), tests: z.array(z.string()).optional(), risks: z.array(z.string()).optional() }, ({ taskId, summary, tests, risks }) => runtime.submitCheckpoint(agentId, taskId, { summary, tests, risks }));
  tool('inspect_agent_diff', 'Read bounded diff for cross-review', { agent: z.string() }, ({ agent }) => runtime.diff(agent));
  tool('request_review', 'Record review request', { agent: z.string(), body: z.string() }, ({ agent, body }) => {
    if (agent === agentId || !runtime.plan.agents.some(a => a.id === agent)) throw new Error('Review target must be another participating agent');
    runtime.state.event(runtime.current().id, agentId, 'review_request', { agent, body });
    return { recorded: true };
  });
  tool('submit_review', 'Submit cross-agent review', { subject: z.string(), verdict: z.enum(['approve', 'changes_requested']), body: z.string() }, ({ subject, verdict, body }) => runtime.submitReview(agentId, subject, verdict, body));
  tool('get_checkpoint_context', 'Read compact checkpoint state', {}, () => runtime.checkpointContext(agentId));
  tool('publish_decision', 'Publish important decision', { body: z.string() }, ({ body }) => runtime.report(agentId, 'decision', body));
  await server.connect(new StdioServerTransport());
  process.on('exit', () => runtime.close());
}
