import { createTavilySearchTool } from '../../execution-core/tavily-search.mjs';
import { createCodeRunHandler } from '../runners/code-runner.mjs';

const CATALOG_ONLY = ['web.scrape','code.analyze','files.read','files.write','files.scan','data.profile','data.chart','image.generate','image.analyze','doc.summarize','pdf.extract','translate','calendar.schedule','email.send'];
export function createLiveToolRegistry({ db, codeRunner, tavily = process.env.TAVILY_API_KEY ? createTavilySearchTool() : null } = {}) {
  const tools = new Map();
  if (tavily) tools.set('web.search', tavily);
  if (db) tools.set('code.run', async (args) => createCodeRunHandler(db, { runner: codeRunner })({ run: args.run, payload: args }));
  return {
    has(toolId) { return tools.has(toolId); },
    async run(toolId, args) { const tool = tools.get(toolId); if (!tool) throw new Error(`TOOL_NOT_CONNECTED:${toolId}`); return tool(args); },
    status() { return { live: [...tools.keys()], catalogOnly: CATALOG_ONLY, simulated: [], unwired: CATALOG_ONLY }; },
  };
}
