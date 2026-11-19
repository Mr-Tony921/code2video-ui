/**
 * Reference 附件的 Gateway 侧代理。
 * 附件文件落在后端机器的 session 目录里，Gateway 通过 Bridge 访问。
 */
import { bridge } from './bridge-client.mjs';

export const bridgeRefs = {
  async assetsJson(pool, session, sessionId) {
    const base = pool.sessionBridgeUrl(session);
    // 增强用：取不到就按"无附件"继续（增强本身不该因此失败），
    // 但要留日志，避免静默丢素材。
    if (!base) {
      console.warn(`[refs] ${sessionId} 的后端进程不可达，本次增强按无附件处理`);
      return [];
    }
    const r = await bridge.refsAssetsJson(base, session.binding.backend_session_ref ?? sessionId);
    return r.assets ?? [];
  },
  async list(pool, session, sessionId) {
    const base = pool.sessionBridgeUrl(session);
    // 进程不可达时【不能】返回空列表 —— 那会让"后端连不上"长得和
    // "没有附件"一模一样，用户以为上传失败/文件丢了。必须抛错，由
    // 调用方回 503，前端显示"后端不可用"。
    if (!base) {
      const e = new Error('该会话绑定的后端进程不可用，暂时无法读取素材列表');
      e.code = 'PROCESS_UNAVAILABLE';
      e.status = 503;
      throw e;
    }
    return bridge.refsList(base, session.binding.backend_session_ref ?? sessionId);
  },
  async freeze(pool, session, sessionId) {
    const base = pool.sessionBridgeUrl(session);
    if (!base) return null;
    return bridge.refsFreeze(base, session.binding.backend_session_ref ?? sessionId);
  },
  async remove(pool, session, sessionId, name) {
    const base = pool.sessionBridgeUrl(session);
    if (!base) throw new Error('后端进程不可用');
    return bridge.refsRemove(base, session.binding.backend_session_ref ?? sessionId, name);
  },
  bridgeBase(pool, session) {
    return pool.sessionBridgeUrl(session);
  },
};
