#!/usr/bin/env python3
"""
Benchmark de Carga Real — Portal Milano Assembleia V2 (200 / 400 / 544 unidades simultâneas).
Executa contra o stack real na VPS (supabase-envoy -> supabase-rest -> supabase-db + realtime),
testando:
  1) N conexões WebSocket Broadcast simultâneas (private: true, RLS read-only)
  2) Rajada concorrente de N votos reais autenticados via JWT Morador (assembleia_registrar_voto)
  3) Latência de assembleia_telao_snapshot (Brotli) com 544 presentes
  4) Limpeza cirúrgica completa apenas dos registros temporários de benchmark,
     preservando 100% intactos os dados históricos (ex.: 19/11/2026).
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
try:
    import resource
except ImportError:
    resource = None
import statistics
import struct
import subprocess
import sys
import time
import urllib.request

HISTORICAL_ASM_ID = "a0000000-0000-4000-8000-202611190001"
ALL_APTOS = [101, 102, 103, 104, 201, 202, 203, 204, 301, 302, 303, 304, 401, 402, 403, 404]


def load_supabase_env():
    r = subprocess.run(
        ["sudo", "-n", "cat", "/srv/portal-milano/infra/03-supabase/.env"],
        capture_output=True, text=True, check=True,
    )
    env_map = {}
    for line in r.stdout.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        env_map[k.strip()] = v.strip().strip('"').strip("'")
    return env_map


def get_envoy_ip():
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", "supabase-envoy"],
        capture_output=True, text=True, check=True,
    )
    return r.stdout.strip().split()[0]


def psql(sql: str) -> str:
    r = subprocess.run(
        ["docker", "exec", "-i", "supabase-db", "psql", "-U", "supabase_admin", "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"psql error: {r.stderr}")
    return r.stdout.strip()


def sign_morador_jwt(jwt_secret: str, asm_id: str, bloco: int, apto: int) -> str:
    now = int(time.time())
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")
    fase = 1 if bloco >= 19 else 2
    modulo = 1 if bloco >= 26 else (2 if bloco >= 19 else (3 if (bloco <= 4 or 9 <= bloco <= 11) else 4))
    payload = {
        "aud": "authenticated",
        "role": "authenticated",
        "sub": f"b0000000-0000-4000-a000-{bloco:04d}{apto:08d}",
        "iat": now,
        "exp": now + 3600,
        "app_metadata": {
            "app_role": "morador",
            "assembleia_id": asm_id,
            "unidades_autorizadas": [{
                "bloco": bloco,
                "apartamento": apto,
                "fase": fase,
                "modulo": modulo,
                "com_procuracao": False,
            }],
        },
    }
    h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    p = b64(json.dumps(payload).encode())
    sig = b64(hmac.new(jwt_secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
    return f"{h}.{p}.{sig}"


def encode_ws_frame(text: str) -> bytes:
    data = text.encode("utf-8")
    mask = os.urandom(4)
    header = bytearray([0x81])
    n = len(data)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack("!Q", n))
    header.extend(mask)
    return bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data))


async def read_ws_frame(reader: asyncio.StreamReader, timeout: float = 10.0) -> str:
    hdr = await asyncio.wait_for(reader.readexactly(2), timeout=timeout)
    length = hdr[1] & 0x7F
    if length == 126:
        ext = await asyncio.wait_for(reader.readexactly(2), timeout=timeout)
        length = struct.unpack("!H", ext)[0]
    elif length == 127:
        ext = await asyncio.wait_for(reader.readexactly(8), timeout=timeout)
        length = struct.unpack("!Q", ext)[0]
    payload = await asyncio.wait_for(reader.readexactly(length), timeout=timeout)
    return payload.decode("utf-8", errors="ignore")


async def open_and_join_ws(host: str, port: int, anon_key: str, topic: str, sem: asyncio.Semaphore):
    async with sem:
        t0 = time.perf_counter()
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=15.0)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET /realtime/v1/websocket?apikey={anon_key}&vsn=1.0.0 HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        writer.write(req.encode())
        await writer.drain()
        resp = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15.0)
        if b"101" not in resp.split(b"\r\n", 1)[0]:
            writer.close()
            return None, None, -1.0, False
        join_msg = json.dumps({
            "topic": topic,
            "event": "phx_join",
            "payload": {"config": {"broadcast": {"ack": False, "self": False}, "private": True}, "access_token": anon_key},
            "ref": "1",
        })
        writer.write(encode_ws_frame(join_msg))
        await writer.drain()
        reply = await read_ws_frame(reader, timeout=15.0)
        dt_ms = (time.perf_counter() - t0) * 1000.0
        ok = '"status":"ok"' in reply
        return reader, writer, dt_ms, ok


async def send_vote_http(host: str, port: int, anon_key: str, jwt: str, pauta_id: str, bloco: int, apto: int, voto: str, idem: str):
    t0 = time.perf_counter()
    body = json.dumps({
        "p_pauta_id": pauta_id,
        "p_bloco": bloco,
        "p_apartamento": apto,
        "p_voto": voto,
        "p_ip_address": "10.0.0.1",
        "p_device_id": f"bench-{bloco}-{apto}",
        "p_device_name": "BenchBot",
        "p_idempotency_key": idem,
    }).encode("utf-8")
    req = (
        f"POST /rest/v1/rpc/assembleia_registrar_voto HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        f"apikey: {anon_key}\r\n"
        f"Authorization: Bearer {jwt}\r\n"
        f"Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n\r\n"
    ).encode("utf-8") + body
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=20.0)
        writer.write(req)
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(), timeout=30.0)
        writer.close()
        dt_ms = (time.perf_counter() - t0) * 1000.0
        status_line = raw.split(b"\r\n", 1)[0].decode(errors="ignore")
        ok = (" 200 " in status_line) and (b'"ok":true' in raw or b'"ok": true' in raw)
        return ok, dt_ms, status_line
    except Exception as e:
        return False, (time.perf_counter() - t0) * 1000.0, str(e)


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    idx = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return s[idx]


def setup_benchmark_assembly():
    sql = """
    INSERT INTO public.assembleias (
      titulo, status, convocacao_ativa, escopo_assembleia,
      exigir_confirmacao_portaria, started_at
    )
    VALUES ('BENCHMARK_TEMP_V2', 'ativa', 'SEGUNDA', 'TODOS', false, now())
    RETURNING id;
    """
    asm_id = psql(sql).splitlines()[0]

    # Popula 544 presencas sinteticas nesta assembleia temporaria
    psql(f"""
    INSERT INTO public.assembleia_presencas (
      assembleia_id, bloco, apartamento, fase, modulo,
      nome_completo, cpf, is_construtora, confirmado_portaria, online_conectado
    )
    SELECT
      '{asm_id}'::uuid,
      b::smallint,
      a::smallint,
      public.assembleia_calcular_fase(b::smallint),
      public.assembleia_calcular_modulo(b::smallint),
      'BENCHMARK UNIDADE ' || b || '-' || a,
      lpad((10000000000 + b * 1000 + a)::text, 11, '0'),
      false,
      true,
      true
    FROM generate_series(1, 34) b
    CROSS JOIN unnest(ARRAY[101,102,103,104,201,202,203,204,301,302,303,304,401,402,403,404]) a;
    """)

    pauta_id = psql(f"""
    INSERT INTO public.assembleia_pautas (assembleia_id, ordem, titulo, escopo, status, opened_at)
    VALUES ('{asm_id}'::uuid, 1, 'Pauta Benchmark Carga V2', 'TODOS', 'aberta', now())
    RETURNING id;
    """).splitlines()[0]

    return asm_id, pauta_id


def cleanup_benchmark_assembly(asm_id: str):
    sql = f"""
    BEGIN;
    SET LOCAL assembleia.bypass_freeze = 'true';
    ALTER TABLE public.assembleia_votos_auditoria DISABLE TRIGGER USER;
    ALTER TABLE public.assembleia_operacoes DISABLE TRIGGER USER;
    ALTER TABLE public.assembleia_historico DISABLE TRIGGER USER;
    ALTER TABLE public.assembleia_votos DISABLE TRIGGER USER;
    ALTER TABLE public.assembleia_presencas DISABLE TRIGGER USER;
    ALTER TABLE public.assembleia_pautas DISABLE TRIGGER USER;

    DELETE FROM public.assembleia_votos_auditoria WHERE assembleia_id = '{asm_id}'::uuid;
    DELETE FROM public.assembleia_operacoes WHERE assembleia_id = '{asm_id}'::uuid;
    DELETE FROM public.assembleia_historico WHERE assembleia_id = '{asm_id}'::uuid;
    DELETE FROM public.assembleia_votos WHERE assembleia_id = '{asm_id}'::uuid;
    DELETE FROM public.assembleia_presencas WHERE assembleia_id = '{asm_id}'::uuid;
    DELETE FROM public.assembleia_pautas WHERE assembleia_id = '{asm_id}'::uuid;
    DELETE FROM public.assembleias WHERE id = '{asm_id}'::uuid;
    DELETE FROM public.assembleia_broadcast_throttle WHERE topic LIKE 'assembleia:{asm_id}:%';

    ALTER TABLE public.assembleia_pautas ENABLE TRIGGER USER;
    ALTER TABLE public.assembleia_presencas ENABLE TRIGGER USER;
    ALTER TABLE public.assembleia_votos ENABLE TRIGGER USER;
    ALTER TABLE public.assembleia_historico ENABLE TRIGGER USER;
    ALTER TABLE public.assembleia_operacoes ENABLE TRIGGER USER;
    ALTER TABLE public.assembleia_votos_auditoria ENABLE TRIGGER USER;
    COMMIT;
    """
    psql(sql)


def clear_benchmark_votes(asm_id: str):
    psql(f"""
    BEGIN;
    SET LOCAL assembleia.bypass_freeze = 'true';
    ALTER TABLE public.assembleia_votos_auditoria DISABLE TRIGGER USER;
    ALTER TABLE public.assembleia_votos DISABLE TRIGGER USER;
    DELETE FROM public.assembleia_votos_auditoria WHERE assembleia_id = '{asm_id}'::uuid;
    DELETE FROM public.assembleia_votos WHERE assembleia_id = '{asm_id}'::uuid;
    ALTER TABLE public.assembleia_votos ENABLE TRIGGER USER;
    ALTER TABLE public.assembleia_votos_auditoria ENABLE TRIGGER USER;
    COMMIT;
    """)


async def run_tier(host: str, port: int, anon_key: str, jwt_secret: str, asm_id: str, pauta_id: str, n: int):
    clear_benchmark_votes(asm_id)
    units = [(b, a) for b in range(1, 35) for a in ALL_APTOS][:n]
    jwts = [sign_morador_jwt(jwt_secret, asm_id, b, a) for b, a in units]
    topic = f"realtime:assembleia:{asm_id}:placar"

    # 1. Abre N WebSockets simultaneos (em batches de 80 para nao estourar backlog SYN do kernel num microsegundo)
    ws_sem = asyncio.Semaphore(80)
    t_ws0 = time.perf_counter()
    ws_results = await asyncio.gather(*[open_and_join_ws(host, port, anon_key, topic, ws_sem) for _ in range(n)])
    ws_total_s = time.perf_counter() - t_ws0
    ws_ok = [r for r in ws_results if r[3]]
    ws_lats = [r[2] for r in ws_ok]

    # 2. Dispara N votos simultaneos (stampede real!)
    t_v0 = time.perf_counter()
    vote_tasks = [
        send_vote_http(
            host, port, anon_key, jwts[i], pauta_id,
            units[i][0], units[i][1],
            "SIM" if i % 2 == 0 else "NAO",
            f"bench-{n}-{units[i][0]}-{units[i][1]}-{int(t_v0*1000)}",
        )
        for i in range(n)
    ]

    # Amostra pico de conexoes Postgres durante a rajada
    peak_conns = 0
    done_flag = False
    async def sample_pg():
        nonlocal peak_conns
        while not done_flag:
            try:
                c = int(psql("SELECT count(*) FROM pg_stat_activity;").splitlines()[0])
                if c > peak_conns:
                    peak_conns = c
            except Exception:
                pass
            await asyncio.sleep(0.15)

    sampler = asyncio.create_task(sample_pg())
    vote_results = await asyncio.gather(*vote_tasks)
    done_flag = True
    await sampler
    vote_total_s = time.perf_counter() - t_v0

    ok_votes = [r for r in vote_results if r[0]]
    fail_votes = [r for r in vote_results if not r[0]]
    v_lats = [r[1] for r in ok_votes]

    # 3. Verifica recebimento de Broadcast em amostra de 20 sockets abertos
    broadcast_hits = 0
    sample_sockets = ws_ok[:min(20, len(ws_ok))]
    async def check_bcast(reader):
        try:
            for _ in range(5):
                m = await read_ws_frame(reader, timeout=1.5)
                if '"placar_update"' in m:
                    return True
        except Exception:
            return False
        return False

    bcast_res = await asyncio.gather(*[check_bcast(r[0]) for r in sample_sockets])
    broadcast_hits = sum(1 for x in bcast_res if x)

    # Fecha todos os WebSockets
    for _, writer, _, _ in ws_results:
        if writer:
            try:
                writer.close()
            except Exception:
                pass

    # 4. Mede telao snapshot com Brotli sob os votos gravados
    t_s0 = time.perf_counter()
    req = urllib.request.Request(
        f"http://{host}:{port}/rest/v1/rpc/assembleia_telao_snapshot",
        data=json.dumps({"p_assembleia_id": asm_id}).encode(),
        headers={"apikey": anon_key, "Authorization": f"Bearer {anon_key}", "Content-Type": "application/json", "Accept-Encoding": "br"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        snap_bytes = len(resp.read())
    snap_ms = (time.perf_counter() - t_s0) * 1000.0

    # Confirma contagem exata gravada no banco + auditoria
    db_counts = psql(
        f"SELECT (SELECT COUNT(*) FROM public.assembleia_votos WHERE pauta_id='{pauta_id}') || '|' || "
        f"(SELECT COUNT(*) FROM public.assembleia_votos_auditoria WHERE pauta_id='{pauta_id}');"
    )

    result = {
        "tier": n,
        "ws_connected": f"{len(ws_ok)}/{n}",
        "ws_join_p50_ms": round(pct(ws_lats, 50), 1),
        "ws_join_p95_ms": round(pct(ws_lats, 95), 1),
        "ws_total_s": round(ws_total_s, 2),
        "votes_ok": f"{len(ok_votes)}/{n}",
        "votes_fail": len(fail_votes),
        "vote_p50_ms": round(pct(v_lats, 50), 1),
        "vote_p95_ms": round(pct(v_lats, 95), 1),
        "vote_p99_ms": round(pct(v_lats, 99), 1),
        "vote_max_ms": round(max(v_lats) if v_lats else 0.0, 1),
        "vote_total_s": round(vote_total_s, 2),
        "throughput_rps": round(len(ok_votes) / max(0.01, vote_total_s), 1),
        "pg_peak_conns": peak_conns,
        "broadcast_sample_hits": f"{broadcast_hits}/{len(sample_sockets)}",
        "telao_br_bytes": snap_bytes,
        "telao_ms": round(snap_ms, 1),
        "db_votes_audit": db_counts,
        "sample_errors": [f[2] for f in fail_votes[:3]],
    }
    print("TIER_RESULT:", json.dumps(result), flush=True)
    return result


async def main():
    if resource is not None:
        try:
            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            target = min(4096, hard) if hard != resource.RLIM_INFINITY else 4096
            if soft < target:
                resource.setrlimit(resource.RLIMIT_NOFILE, (target, hard))
        except Exception:
            pass
    tiers = [int(x) for x in sys.argv[1:]] if len(sys.argv) > 1 else [200, 400, 544]
    env = load_supabase_env()
    host = get_envoy_ip()
    port = 8000
    anon = env["ANON_KEY"]
    jwt_secret = env["JWT_SECRET"]

    # Verifica historico 19/11 ANTES
    before_hist = psql(
        f"SELECT (SELECT COUNT(*) FROM public.assembleia_votos WHERE assembleia_id='{HISTORICAL_ASM_ID}') || '|' || "
        f"(SELECT COUNT(*) FROM public.assembleia_presencas WHERE assembleia_id='{HISTORICAL_ASM_ID}');"
    )
    print(f"HIST_19_11_BEFORE: {before_hist} | TARGET: {host}:{port} | TIERS: {tiers}", flush=True)

    asm_id, pauta_id = setup_benchmark_assembly()
    print(f"BENCHMARK_ASM_CREATED: {asm_id}", flush=True)
    try:
        for n in tiers:
            await run_tier(host, port, anon, jwt_secret, asm_id, pauta_id, n)
            await asyncio.sleep(1.5)
    finally:
        cleanup_benchmark_assembly(asm_id)
        after_hist = psql(
            f"SELECT (SELECT COUNT(*) FROM public.assembleia_votos WHERE assembleia_id='{HISTORICAL_ASM_ID}') || '|' || "
            f"(SELECT COUNT(*) FROM public.assembleia_presencas WHERE assembleia_id='{HISTORICAL_ASM_ID}') || '|' || "
            f"(SELECT COUNT(*) FROM public.assembleias);"
        )
        print(f"BENCHMARK_CLEANED | HIST_19_11_AFTER (votos|pres|total_asm): {after_hist}", flush=True)
        assert after_hist == "732|170|1", f"Divergencia pos-limpeza: {after_hist}"


if __name__ == "__main__":
    asyncio.run(main())
