import { DurableObject } from "cloudflare:workers";

// 참가자에게 보내도 되는 필드만 골라낸다 (선정 이유 같은 내부 메모, 큐포인트는 제외)
const PUBLIC_FIELDS = ["id", "index", "title", "artist", "album", "year", "session", "notes", "points", "related"];
const pick = (t) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, t?.[k] ?? ""]));
const EMPTY = { now: null, unlocked: [] };

/**
 * 행사 하나의 라이브 상태.
 * 서버는 관리자가 "공개"한 곡만 알고 있으므로 미래 곡은 애초에 참가자에게 갈 수 없다.
 */
export class LiveRoom extends DurableObject {
  async getState() {
    return (await this.ctx.storage.get("state")) || structuredClone(EMPTY);
  }

  broadcast(state) {
    const msg = JSON.stringify({ type: "state", ...state });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 참가자 실시간 연결
    if (url.pathname === "/live") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("WebSocket only", { status: 426 });
      }
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "state", ...(await this.getState()) }));
      return new Response(null, { status: 101, webSocket: client });
    }

    // 현재 상태 조회
    if (url.pathname === "/api/state" && request.method === "GET") {
      return Response.json({ ...(await this.getState()), listeners: this.ctx.getWebSockets().length });
    }

    // 관리자: 곡 공개(= 지금 재생 중으로 지정 + 해금)
    if (url.pathname === "/api/now" && request.method === "POST") {
      const track = pick(await request.json());
      if (!track.id) return new Response("track id required", { status: 400 });
      const state = await this.getState();
      state.now = track;
      const i = state.unlocked.findIndex((t) => t.id === track.id);
      if (i >= 0) state.unlocked[i] = track;
      else state.unlocked.push(track);
      await this.ctx.storage.put("state", state);
      this.broadcast(state);
      return Response.json({ ok: true, listeners: this.ctx.getWebSockets().length });
    }

    // 관리자: 잘못 해금한 곡 되돌리기
    if (url.pathname === "/api/unlock" && request.method === "DELETE") {
      const { id } = await request.json();
      const state = await this.getState();
      state.unlocked = state.unlocked.filter((t) => t.id !== id);
      if (state.now?.id === id) state.now = null;
      await this.ctx.storage.put("state", state);
      this.broadcast(state);
      return Response.json({ ok: true });
    }

    // 관리자: 행사 초기화
    if (url.pathname === "/api/reset" && request.method === "POST") {
      await this.ctx.storage.put("state", structuredClone(EMPTY));
      this.broadcast(EMPTY);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws, message) {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws, code) {
    try { ws.close(code, "bye"); } catch {}
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/live" || url.pathname.startsWith("/api/")) {
      // 상태를 바꾸는 요청은 관리자 토큰 필요
      if (request.method !== "GET") {
        const token = request.headers.get("x-admin-token");
        if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
          return new Response("관리자 토큰이 맞지 않습니다", { status: 401 });
        }
      }
      const room = env.LIVE.get(env.LIVE.idFromName("main"));
      return room.fetch(request);
    }

    // 나머지는 public 폴더의 파일
    return env.ASSETS.fetch(request);
  },
};
