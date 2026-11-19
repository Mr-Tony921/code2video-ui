import { adminModelViews, lastPersonalModel, prepareConnection, saveModel, checkConnection } from '../../shared/model-settings.mjs';

import { sekoAdminModel, prepareSekoConnection, saveSekoModel, checkSekoConnection } from '../../shared/seko-model.mjs';

export function modelSettingsRoutes({ config, currentUser, experimentalUser, users, json, readJson }) {
  async function admin(req) {
    const signed = currentUser(req);
    if (!signed) throw Object.assign(new Error('未登录'), { status: 401, code: 'UNAUTHENTICATED' });
    const live = await users.get(signed.username);
    if (live?.role !== 'admin' || live.status !== 'active')
      throw Object.assign(new Error('需要管理员权限'), { status: 403, code: 'FORBIDDEN' });
    return live;
  }
  function purpose(id) {
    if (!['c2v', 'enhancement'].includes(id)) throw Object.assign(new Error('模型用途无效'), { status: 400, code: 'VALIDATION_FAILED' });
    return id;
  }
  return {
    'GET /api/admin/whitebox/model': async (req, res) => { await admin(req); json(res, 200, { model: sekoAdminModel(config.raw) }); },
    'PATCH /api/admin/whitebox/model': async (req, res) => { await admin(req); json(res, 200, { model: saveSekoModel(config.raw, await readJson(req)) }); },
    'POST /api/admin/whitebox/model/check': async (req, res) => { await admin(req); json(res, 200, await checkSekoConnection(prepareSekoConnection(config.raw, await readJson(req)))); },
    'GET /api/admin/models': async (req, res) => {
      await admin(req);
      json(res, 200, { models: adminModelViews(config.raw) });
    },
    'PATCH /api/admin/models/:purpose': async (req, res, p) => {
      const user = await admin(req);
      json(res, 200, { model: saveModel(config.raw, purpose(p.purpose), user.id, await readJson(req)) });
    },
    'POST /api/admin/models/:purpose/check': async (req, res, p) => {
      const user = await admin(req);
      const connection = prepareConnection(config.raw, purpose(p.purpose), user.id, await readJson(req));
      json(res, 200, await checkConnection(connection));
    },
    'GET /api/experimental/custom-model': async (req, res) => {
      const user = await experimentalUser(req);
      json(res, 200, { model: lastPersonalModel(config.raw, user.id) });
    },
    'POST /api/experimental/custom-model': async (req, res) => {
      const user = await experimentalUser(req);
      json(res, 200, { model: saveModel(config.raw, 'experimental', user.id, await readJson(req)) });
    },
    'POST /api/experimental/custom-model/check': async (req, res) => {
      const user = await experimentalUser(req);
      json(res, 200, await checkConnection(prepareConnection(config.raw, 'experimental', user.id, await readJson(req))));
    },
  };
}
