import { DurableObject } from "cloudflare:workers";

// 참가자에게 보내도 되는 곡 필드 (선정 이유·큐포인트·타임코드는 제외)
const TRACK_FIELDS = ["id", "sid", "index", "title", "artist", "album", "year", "notes", "related", "img"];
const pickTrack = (t) => Object.fromEntries(TRACK_FIELDS.map((k) => [k, t?.[k] ?? ""]));
// 세션은 이름·설명·곡 수만 (곡 제목은 공개 전까지 서버에도 없음)
const pickSession = (s) => ({
  id: String(s?.id ?? ""),
  name: String(s?.name ?? ""),
  desc: String(s?.desc ?? ""),
  count: Math.max(0, Number(s?.count) || 0),
});
const empty = () => ({ program: { sessions: [] }, now: null, unlocked: [], counts: {} });
const MAX_EVENT_BYTES = 1_900_000;
const MAX_IMG_BYTES = 600_000;
const REACTIONS = ["heart", "party", "clap", "smile", "dance"];
const IMG_TYPES = ["image/jpeg", "image/png", "image/webp"];
const str = (v, max) => String(v ?? "").trim().slice(0, max);
// 보이는 댓글: 숨김 처리 안 됐고, 답글이면 원 댓글도 살아 있어야 한다
const visibleComments = (list) => {
  const alive = new Set(list.filter((c) => !c.hidden && !c.parent).map((c) => c.key));
  return list.filter((c) => !c.hidden && (!c.parent || alive.has(c.parent)));
};
// 참가자에게 보내는 형태 (작성자 기기 ID·좋아요 누른 사람 목록은 빼고 숫자만)
const pubComment = (c, cid) => ({
  key: c.key, parent: c.parent || "", nick: c.nick, text: c.text, at: c.at,
  likes: (c.likes || []).length, ...(cid !== undefined ? { liked: (c.likes || []).includes(cid) } : {}),
});

export class LiveRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.lastComment = new Map(); // 참가자별 마지막 댓글 시각 (도배 방지)
  }

  async getState() {
    const s = (await this.ctx.storage.get("state")) || empty();
    s.program ||= { sessions: [] };
    s.unlocked ||= [];
    s.counts ||= {};
    return s;
  }

  send(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  async setState(state) {
    await this.ctx.storage.put("state", state);
    this.send({ type: "state", ...state });
  }

  async ratingSummary(id, cid) {
    const r = (await this.ctx.storage.get("r:" + id)) || {};
    const vals = Object.values(r);
    return {
      avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0,
      n: vals.length,
      mine: cid ? r[cid] || 0 : 0,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;

    // ---------- 참가자 실시간 연결 ----------
    if (url.pathname === "/live") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket only", { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "state", ...(await this.getState()) }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/api/state" && method === "GET") {
      return Response.json({ ...(await this.getState()), listeners: this.ctx.getWebSockets().length });
    }

    // ---------- 관리자: 세션 구성(이름·설명·곡 수) ----------
    if (url.pathname === "/api/program" && method === "POST") {
      const body = await request.json();
      const state = await this.getState();
      state.program = { sessions: (body.sessions || []).map(pickSession) };
      await this.setState(state);
      return Response.json({ ok: true });
    }

    // ---------- 썸네일 ----------
    const im = url.pathname.match(/^\/(?:api\/)?img\/([\w-]+)$/);
    if (im) {
      const id = im[1];
      if (method === "GET" && url.pathname.startsWith("/img/")) {
        // 공개된 곡이거나 관리자일 때만 (미공개 곡 이미지 노출 방지)
        if (request.headers.get("x-admin") !== "1") {
          const state = await this.getState();
          if (!state.unlocked.some((t) => t.id === id)) return new Response("Not found", { status: 404 });
        }
        const img = await this.ctx.storage.get("img:" + id);
        if (!img) return new Response("Not found", { status: 404 });
        return new Response(img.data, {
          headers: { "content-type": img.type, "cache-control": "private, max-age=86400" },
        });
      }
      if (method === "PUT") {
        const type = (request.headers.get("content-type") || "").split(";")[0];
        if (!IMG_TYPES.includes(type)) return new Response("JPG/PNG/WEBP만 가능합니다", { status: 415 });
        const data = await request.arrayBuffer();
        if (data.byteLength > MAX_IMG_BYTES) return new Response("이미지가 너무 큽니다", { status: 413 });
        await this.ctx.storage.put("img:" + id, { type, data });
        return Response.json({ ok: true, v: Date.now() });
      }
      if (method === "DELETE") {
        await this.ctx.storage.delete("img:" + id);
        return Response.json({ ok: true });
      }
    }

    // ---------- 참가자: 곡 상세 (별점 요약 + 댓글) ----------
    const tm = url.pathname.match(/^\/api\/track\/([\w-]+)$/);
    if (tm && method === "GET") {
      const id = tm[1];
      const state = await this.getState();
      if (!state.unlocked.some((t) => t.id === id)) return new Response("아직 공개되지 않은 곡", { status: 403 });
      const cid = url.searchParams.get("cid") || "";
      const list = (await this.ctx.storage.get("c:" + id)) || [];
      const comments = visibleComments(list).map((c) => pubComment(c, cid));
      return Response.json({ ...(await this.ratingSummary(id, cid)), comments });
    }

    // ---------- 참가자: 별점 ----------
    if (url.pathname === "/api/rate" && method === "POST") {
      const b = await request.json();
      const id = str(b.id, 20), cid = str(b.cid, 64), score = Math.round(Number(b.score));
      if (!id || !cid || !(score >= 1 && score <= 5)) return new Response("잘못된 요청", { status: 400 });
      const state = await this.getState();
      if (!state.unlocked.some((t) => t.id === id)) return new Response("아직 공개되지 않은 곡", { status: 403 });
      const r = (await this.ctx.storage.get("r:" + id)) || {};
      r[cid] = score;
      await this.ctx.storage.put("r:" + id, r);
      return Response.json(await this.ratingSummary(id, cid));
    }

    // ---------- 참가자: 댓글 · 답글 ----------
    if (url.pathname === "/api/comment" && method === "POST") {
      const b = await request.json();
      const id = str(b.id, 20), cid = str(b.cid, 64), nick = str(b.nick, 20), text = str(b.text, 300), parent = str(b.parent, 20);
      if (!id || !cid || !nick || !text) return new Response("닉네임과 내용을 입력하세요", { status: 400 });
      const state = await this.getState();
      if (!state.unlocked.some((t) => t.id === id)) return new Response("아직 공개되지 않은 곡", { status: 403 });
      const now = Date.now();
      if (now - (this.lastComment.get(cid) || 0) < 5000) return new Response("잠시 후에 다시 남겨주세요", { status: 429 });
      const list = (await this.ctx.storage.get("c:" + id)) || [];
      // 답글은 한 단계만: 원 댓글이 살아 있는 일반 댓글이어야 한다
      if (parent && !list.some((c) => c.key === parent && !c.parent && !c.hidden)) return new Response("원 댓글을 찾을 수 없어요", { status: 400 });
      if (list.some((c) => c.by === cid && c.text === text && (c.parent || "") === parent && !c.hidden)) return new Response("같은 댓글이 이미 있어요", { status: 409 });
      const comment = { key: crypto.randomUUID().slice(0, 8), by: cid, nick, text, at: now, likes: [] };
      if (parent) comment.parent = parent;
      list.push(comment);
      this.lastComment.set(cid, now);
      await this.ctx.storage.put("c:" + id, list);
      state.counts[id] = visibleComments(list).length;
      await this.ctx.storage.put("state", state);
      this.send({ type: "comment", id, comment: pubComment(comment), count: state.counts[id] });
      return Response.json({ ok: true, comment: pubComment(comment, cid) });
    }

    // ---------- 참가자: 노래 반응 (저장하지 않고 송출 화면으로 바로 보냄, 횟수 제한 없음) ----------
    if (url.pathname === "/api/react" && method === "POST") {
      const b = await request.json();
      const cid = str(b.cid, 64), e = str(b.e, 10);
      if (!cid || !REACTIONS.includes(e)) return new Response("잘못된 요청", { status: 400 });
      this.send({ type: "react", e });
      return Response.json({ ok: true });
    }

    // ---------- 참가자: 댓글 좋아요 (누를 때마다 켜고 끄기) ----------
    if (url.pathname === "/api/like" && method === "POST") {
      const b = await request.json();
      const id = str(b.id, 20), key = str(b.key, 20), cid = str(b.cid, 64);
      if (!id || !key || !cid) return new Response("잘못된 요청", { status: 400 });
      const state = await this.getState();
      if (!state.unlocked.some((t) => t.id === id)) return new Response("아직 공개되지 않은 곡", { status: 403 });
      const list = (await this.ctx.storage.get("c:" + id)) || [];
      const c = visibleComments(list).find((x) => x.key === key);
      if (!c) return new Response("없는 댓글", { status: 404 });
      c.likes ||= [];
      const i = c.likes.indexOf(cid);
      if (i >= 0) c.likes.splice(i, 1);
      else c.likes.push(cid);
      await this.ctx.storage.put("c:" + id, list);
      this.send({ type: "like", id, key, likes: c.likes.length });
      return Response.json({ ok: true, likes: c.likes.length, liked: i < 0 });
    }

    // ---------- 관리자: 댓글 숨기기 (답글이 달린 댓글이면 답글도 함께 안 보임) ----------
    if (url.pathname === "/api/comment" && method === "DELETE") {
      const { id, key } = await request.json();
      const list = (await this.ctx.storage.get("c:" + id)) || [];
      const c = list.find((x) => x.key === key);
      if (!c) return new Response("없는 댓글", { status: 404 });
      c.hidden = true;
      await this.ctx.storage.put("c:" + id, list);
      const state = await this.getState();
      state.counts[id] = visibleComments(list).length;
      await this.ctx.storage.put("state", state);
      this.send({ type: "uncomment", id, key, count: state.counts[id] });
      return Response.json({ ok: true });
    }

    // ---------- 관리자: 곡 공개 ----------
    if (url.pathname === "/api/now" && method === "POST") {
      const body = await request.json();
      // 곡 정보 공개 전: 지금 곡이 재생 중이라는 것만 알리고, 제목 등은 보내지 않는다
      if (body.mystery) {
        const state = await this.getState();
        state.now = { mystery: true, sid: str(body.sid, 40), index: Number(body.index) || 0 };
        await this.setState(state);
        return Response.json({ ok: true, listeners: this.ctx.getWebSockets().length });
      }
      const track = pickTrack(body);
      if (!track.id) return new Response("track id required", { status: 400 });
      const state = await this.getState();
      state.now = track;
      const i = state.unlocked.findIndex((t) => t.id === track.id);
      if (i >= 0) state.unlocked[i] = track;
      else state.unlocked.push(track);
      await this.setState(state);
      return Response.json({ ok: true, listeners: this.ctx.getWebSockets().length });
    }

    // 관리자: 이미 공개된 곡의 정보만 갱신 (지금 곡은 바꾸지 않음)
    if (url.pathname === "/api/track-update" && method === "POST") {
      const track = pickTrack(await request.json());
      const state = await this.getState();
      const i = state.unlocked.findIndex((t) => t.id === track.id);
      if (i < 0) return Response.json({ ok: true, unlocked: false });
      state.unlocked[i] = track;
      if (state.now?.id === track.id) state.now = track;
      await this.setState(state);
      return Response.json({ ok: true, unlocked: true });
    }

    if (url.pathname === "/api/unlock" && method === "DELETE") {
      const { id } = await request.json();
      const state = await this.getState();
      state.unlocked = state.unlocked.filter((t) => t.id !== id);
      if (state.now?.id === id) state.now = null;
      await this.setState(state);
      return Response.json({ ok: true });
    }

    // 공개 목록·별점·댓글을 비운다 (세션 구성은 유지)
    if (url.pathname === "/api/reset" && method === "POST") {
      const state = await this.getState();
      state.now = null;
      state.unlocked = [];
      state.counts = {};
      for (const prefix of ["r:", "c:"]) {
        const keys = [...(await this.ctx.storage.list({ prefix })).keys()];
        for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
      }
      this.lastComment.clear();
      await this.setState(state);
      return Response.json({ ok: true });
    }

    // ---------- 관리자: 행사 파일 저장소 ----------
    const m = url.pathname.match(/^\/api\/events(?:\/(.+))?$/);
    if (m) {
      const name = m[1] ? decodeURIComponent(m[1]) : null;
      const storage = this.ctx.storage;

      if (!name) {
        if (method !== "GET") return new Response("Not found", { status: 404 });
        const metas = await storage.list({ prefix: "meta:" });
        return Response.json([...metas.values()].sort((a, b) => b.updatedAt - a.updatedAt));
      }
      if (name.length > 100) return new Response("행사 이름이 너무 깁니다", { status: 400 });

      if (method === "GET") {
        const [text, meta] = await Promise.all([storage.get("event:" + name), storage.get("meta:" + name)]);
        if (!text) return new Response("없는 행사", { status: 404 });
        return new Response(`{"updatedAt":${meta?.updatedAt || 0},"event":${text}}`, {
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "PUT") {
        const text = await request.text();
        if (new TextEncoder().encode(text).length > MAX_EVENT_BYTES) {
          return new Response("행사 데이터가 너무 큽니다", { status: 413 });
        }
        let ev;
        try { ev = JSON.parse(text); } catch { return new Response("JSON 형식 오류", { status: 400 }); }
        const meta = await storage.get("meta:" + name);
        const base = request.headers.get("x-base") || "0";
        // 다른 기기에서 먼저 저장했으면 덮어쓰지 않는다
        if (base !== "force" && String(meta?.updatedAt || 0) !== base) {
          return Response.json({ error: "conflict", updatedAt: meta?.updatedAt || 0 }, { status: 409 });
        }
        const updatedAt = Math.max(Date.now(), (meta?.updatedAt || 0) + 1);
        await storage.put({
          ["event:" + name]: text,
          ["meta:" + name]: { name, updatedAt, count: Array.isArray(ev.tracks) ? ev.tracks.length : 0 },
        });
        return Response.json({ ok: true, updatedAt });
      }

      if (method === "DELETE") {
        await storage.delete(["event:" + name, "meta:" + name]);
        return Response.json({ ok: true });
      }
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

    // 썸네일 보기: 관리자 화면은 ?k=토큰 으로 미공개 곡 이미지도 볼 수 있다
    if (url.pathname.startsWith("/img/") && request.method === "GET") {
      const headers = new Headers(request.headers);
      headers.delete("x-admin"); // 밖에서 넣은 값은 믿지 않는다
      if (env.ADMIN_TOKEN && url.searchParams.get("k") === env.ADMIN_TOKEN) headers.set("x-admin", "1");
      return env.LIVE.get(env.LIVE.idFromName("main")).fetch(new Request(request.url, { method: "GET", headers }));
    }

    if (url.pathname === "/live" || url.pathname.startsWith("/api/")) {
      // 상태를 바꾸는 요청과 행사 파일은 관리자 토큰 필요
      // 별점·댓글 작성은 참가자도 가능
      const participantWrite = request.method === "POST" && ["/api/rate", "/api/comment", "/api/like", "/api/react"].includes(url.pathname);
      const needsToken = url.pathname.startsWith("/api/events") || (request.method !== "GET" && !participantWrite);
      if (needsToken) {
        const token = request.headers.get("x-admin-token");
        if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
          return new Response("관리자 토큰이 맞지 않습니다", { status: 401 });
        }
      }
      // x-admin 헤더는 /img/ 경로에서만 의미가 있고, /img/ 요청은 위에서 따로 정리해 보낸다
      return env.LIVE.get(env.LIVE.idFromName("main")).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
