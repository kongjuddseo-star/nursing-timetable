"""간호학과 시간표 배치 — 로그인한 사람만 쓰는 작은 웹 서버.

화면(static/app.html)이 시간표 계산을 모두 브라우저에서 하고,
서버는 로그인·계정과 시간표 데이터(저장본) 보관만 맡는다.
데이터는 DATA_DIR(Railway Volume, /data)의 SQLite 파일에 있다.
"""
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, g, jsonify, redirect, render_template, request, send_from_directory, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(BASE, "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "timetable.db")
KST = timezone(timedelta(hours=9))
KEEP_VERSIONS = 200  # 저장본은 최근 200개까지 보관


def _secret_key():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(DATA_DIR, "secret_key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app = Flask(__name__, static_folder=None)
app.secret_key = _secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RAILWAY_ENVIRONMENT")),
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    MAX_CONTENT_LENGTH=20 * 1024 * 1024,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, login_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, pw_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1,
  init_pw INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions(
  id INTEGER PRIMARY KEY, state TEXT NOT NULL, saved_by TEXT NOT NULL, saved_at TEXT NOT NULL, note TEXT);
"""
ROLES = ("관리자", "직원")


def now():
    return datetime.now(KST).isoformat(timespec="seconds")


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=10)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def _close(_exc):
    con = g.pop("db", None)
    if con is not None:
        con.close()


def init_db():
    """처음 실행할 때 표를 만들고, 계정과 처음 시간표(seed_state.json)를 넣는다.

    INIT_ACCOUNTS = "아이디|직위|이름;아이디|직위|이름" (직위: 관리자 또는 직원)
    INIT_PASSWORD = 처음 비밀번호(모두 같음, 처음 로그인하면 각자 바꿈)
    RESET_PASSWORD_FOR = "아이디,아이디" → 그 계정 비밀번호를 INIT_PASSWORD로 한 번 초기화
    """
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.executescript(SCHEMA)
    pw = os.environ.get("INIT_PASSWORD")
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0 and pw:
        for part in (os.environ.get("INIT_ACCOUNTS") or "").split(";"):
            bits = [x.strip() for x in part.split("|")]
            if len(bits) != 3 or not bits[0]:
                continue
            login, role, name = bits
            role = role if role in ROLES else "직원"
            con.execute("INSERT OR IGNORE INTO users(login_id,name,role,pw_hash,must_change,init_pw,created_at) VALUES(?,?,?,?,1,1,?)",
                        (login, name, role, generate_password_hash(pw), now()))
    if pw:
        # 처음 비밀번호를 아직 안 바꾼 계정은 지금의 INIT_PASSWORD를 따른다
        for uid, h in con.execute("SELECT id,pw_hash FROM users WHERE init_pw=1").fetchall():
            if not check_password_hash(h, pw):
                con.execute("UPDATE users SET pw_hash=?,must_change=1 WHERE id=?", (generate_password_hash(pw), uid))
        reset = (os.environ.get("RESET_PASSWORD_FOR") or "").strip()
        marker = os.path.join(DATA_DIR, "reset_done")
        done = open(marker).read() if os.path.exists(marker) else ""
        if reset and reset != done:
            for login in [x.strip() for x in reset.split(",") if x.strip()]:
                con.execute("UPDATE users SET pw_hash=?,must_change=1,init_pw=1 WHERE login_id=?", (generate_password_hash(pw), login))
            with open(marker, "w") as f:
                f.write(reset)
    if con.execute("SELECT COUNT(*) FROM versions").fetchone()[0] == 0:
        seed = os.path.join(BASE, "seed_state.json")
        if os.path.exists(seed):
            with open(seed, encoding="utf-8") as f:
                con.execute("INSERT INTO versions(state,saved_by,saved_at,note) VALUES(?,?,?,?)",
                            (f.read(), "처음 데이터", now(), "2026-11-27 가안"))
    con.commit()
    con.close()


init_db()


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def login_required(api=False):
    def deco(f):
        @wraps(f)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                return (jsonify(error="login"), 401) if api else redirect(url_for("login_page"))
            if u["must_change"] and not api and request.endpoint not in ("account", "account_post", "logout"):
                return redirect(url_for("account"))
            if u["must_change"] and api:
                return jsonify(error="password"), 403
            g.user = u
            return f(*a, **kw)
        return wrapper
    return deco


@app.after_request
def _headers(resp):
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    if request.path.startswith("/api/") or request.path == "/":
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/healthz")
def healthz():
    return "ok"


# ---------- 로그인 ----------
@app.get("/login")
def login_page():
    return render_template("login.html", error=None)


_fails = {}


@app.post("/login")
def login_post():
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()
    t, n = _fails.get(ip, (datetime.now(), 0))
    if n >= 10 and datetime.now() - t < timedelta(minutes=10):
        return render_template("login.html", error="여러 번 틀렸습니다. 10분 뒤에 다시 해 주세요."), 429
    login = (request.form.get("login_id") or "").strip()
    pw = request.form.get("password") or ""
    u = db().execute("SELECT * FROM users WHERE login_id=?", (login,)).fetchone()
    if not u or not check_password_hash(u["pw_hash"], pw):
        _fails[ip] = (datetime.now(), n + 1)
        return render_template("login.html", error="아이디 또는 비밀번호가 맞지 않습니다."), 401
    _fails.pop(ip, None)
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    return redirect(url_for("account") if u["must_change"] else url_for("index"))


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))


# ---------- 계정 ----------
def _users():
    return db().execute("SELECT id,login_id,name,role,must_change,created_at FROM users ORDER BY id").fetchall()


@app.get("/account")
@login_required()
def account():
    return render_template("account.html", me=g.user, users=_users() if g.user["role"] == "관리자" else [], msg=None, err=None, roles=ROLES)


@app.post("/account")
@login_required()
def account_post():
    me, f, con = g.user, request.form, db()
    action = f.get("action")
    msg = err = None
    if action == "password":
        cur, new, new2 = f.get("current") or "", f.get("new") or "", f.get("new2") or ""
        if not check_password_hash(me["pw_hash"], cur):
            err = "지금 비밀번호가 맞지 않습니다."
        elif len(new) < 8:
            err = "새 비밀번호는 8자 이상이어야 합니다."
        elif new != new2:
            err = "새 비밀번호 두 칸이 다릅니다."
        elif new == cur:
            err = "지금과 다른 비밀번호를 정해 주세요."
        else:
            con.execute("UPDATE users SET pw_hash=?,must_change=0,init_pw=0 WHERE id=?", (generate_password_hash(new), me["id"]))
            con.commit()
            return redirect(url_for("index"))
    elif me["must_change"]:
        err = "먼저 비밀번호를 바꿔 주세요."
    elif me["role"] != "관리자":
        err = "계정 관리는 관리자만 할 수 있습니다."
    elif action == "add":
        login, name, role, pw = (f.get("login_id") or "").strip(), (f.get("name") or "").strip(), f.get("role"), f.get("password") or ""
        if not login or not name or len(pw) < 8:
            err = "아이디·이름을 적고, 처음 비밀번호는 8자 이상으로 해 주세요."
        elif con.execute("SELECT 1 FROM users WHERE login_id=?", (login,)).fetchone():
            err = "이미 있는 아이디입니다."
        else:
            con.execute("INSERT INTO users(login_id,name,role,pw_hash,must_change,created_at) VALUES(?,?,?,?,1,?)",
                        (login, name, role if role in ROLES else "직원", generate_password_hash(pw), now()))
            con.commit()
            msg = f"{name} 계정을 만들었습니다. 처음 로그인하면 비밀번호를 바꾸게 됩니다."
    elif action in ("reset", "delete", "rename"):
        uid = int(f.get("uid") or 0)
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            err = "계정을 찾을 수 없습니다."
        elif action == "delete":
            if u["id"] == me["id"]:
                err = "자기 계정은 지울 수 없습니다."
            else:
                con.execute("DELETE FROM users WHERE id=?", (uid,))
                con.commit()
                msg = f"{u['name']} 계정을 지웠습니다."
        elif action == "reset":
            pw = f.get("password") or ""
            if len(pw) < 8:
                err = "임시 비밀번호는 8자 이상이어야 합니다."
            else:
                con.execute("UPDATE users SET pw_hash=?,must_change=1 WHERE id=?", (generate_password_hash(pw), uid))
                con.commit()
                msg = f"{u['name']} 계정 비밀번호를 초기화했습니다. 다음 로그인 때 바꾸게 됩니다."
        else:
            name, role = (f.get("name") or "").strip(), f.get("role")
            if not name:
                err = "이름을 적어 주세요."
            elif u["id"] == me["id"] and role != "관리자":
                err = "자기 계정의 관리자 권한은 뺄 수 없습니다."
            else:
                con.execute("UPDATE users SET name=?,role=? WHERE id=?", (name, role if role in ROLES else "직원", uid))
                con.commit()
                msg = "고쳤습니다."
    me = con.execute("SELECT * FROM users WHERE id=?", (me["id"],)).fetchone()
    return render_template("account.html", me=me, users=_users() if me["role"] == "관리자" else [], msg=msg, err=err, roles=ROLES)


# ---------- 화면과 데이터 ----------
@app.get("/")
@login_required()
def index():
    return send_from_directory(os.path.join(BASE, "static"), "app.html")


@app.get("/api/me")
@login_required(api=True)
def api_me():
    return jsonify(login_id=g.user["login_id"], name=g.user["name"], role=g.user["role"])


def _latest():
    return db().execute("SELECT * FROM versions ORDER BY id DESC LIMIT 1").fetchone()


@app.get("/api/state")
@login_required(api=True)
def api_state():
    v = _latest()
    state = json.loads(v["state"])
    state["savedAt"] = v["saved_at"]
    return jsonify(state=state, version=v["id"], savedBy=v["saved_by"], savedAt=v["saved_at"])


@app.put("/api/state")
@login_required(api=True)
def api_save():
    body = request.get_json(silent=True) or {}
    state = body.get("state")
    if not isinstance(state, dict) or "courses" not in state:
        return jsonify(error="bad"), 400
    con = db()
    con.execute("BEGIN IMMEDIATE")
    v = _latest()
    if body.get("base") is not None and v and int(body["base"]) != v["id"]:
        con.rollback()
        return jsonify(error="conflict", savedBy=v["saved_by"], savedAt=v["saved_at"]), 409
    t = now()
    state["savedAt"] = t
    cur = con.execute("INSERT INTO versions(state,saved_by,saved_at) VALUES(?,?,?)",
                      (json.dumps(state, ensure_ascii=False), g.user["name"], t))
    con.execute("DELETE FROM versions WHERE id NOT IN (SELECT id FROM versions ORDER BY id DESC LIMIT ?)", (KEEP_VERSIONS,))
    con.commit()
    return jsonify(version=cur.lastrowid, savedAt=t)


@app.get("/api/versions")
@login_required(api=True)
def api_versions():
    rows = db().execute("SELECT id,saved_by,saved_at,note FROM versions ORDER BY id DESC LIMIT 50").fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/versions/<int:vid>/restore")
@login_required(api=True)
def api_restore(vid):
    con = db()
    v = con.execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not v:
        return jsonify(error="none"), 404
    t = now()
    cur = con.execute("INSERT INTO versions(state,saved_by,saved_at,note) VALUES(?,?,?,?)",
                      (v["state"], g.user["name"], t, f"{v['saved_at']} 저장본으로 되돌림"))
    con.commit()
    return jsonify(version=cur.lastrowid)
