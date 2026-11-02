// Resolve only the explicitly supplied environment or the task's own dependencies.
import {createRequire} from 'node:module';
import path from 'node:path';
export function dependencyRequire(project) {
  const root=path.resolve(process.env.PREVIS_DEPENDENCY_ROOT || project);
  return createRequire(path.join(root,'package.json'));
}
