// Herdr action: dev-fetch-work-items
//
// Reads my assigned Azure Boards items in the target project (To Do, Doing, Done)
// and writes them to work-items.json in the state directory. Prints one JSON line
// with the state directory this action ran with, so the mod can check it.

import {
  DevError,
  azure,
  fail,
  loadActiveProject,
  paths,
  report,
  stateDir,
  writeJson,
} from "./dev-lib";

const dir = stateDir();

try {
  const project = await loadActiveProject(dir);
  const items = await azure.query(project.azureProject);
  const fetchedAt = new Date().toISOString();
  await writeJson(paths.workItems(dir), { fetchedAt, project: project.azureProject, items });
  report({ ok: true, stateDir: dir, fetchedAt, count: items.length });
} catch (err) {
  fail(err instanceof DevError ? err.message : String(err));
}
