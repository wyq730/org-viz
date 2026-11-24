#!/usr/bin/env python3
"""全公司通讯录结构导出 (bot identity via lark-cli)."""
import csv, json, re, subprocess, sys, time
from collections import OrderedDict
from pathlib import Path

DATE = time.strftime("%Y-%m-%d")  # 自动取运行日
OUT = Path.home() / f".agents/tmp_workspaces/org_export_{DATE}"
OUT.mkdir(parents=True, exist_ok=True)
SLEEP = 0.15

def cli(method_path, params=None):
    method, _, path = method_path.partition(" ")
    args = ["lark-cli", "api", method, path, "--as", "bot"]
    if params:
        args += ["--params", json.dumps(params)]
    for attempt in range(5):
        p = subprocess.run(args, capture_output=True, text=True, timeout=60)
        try:
            d = json.loads(p.stdout)
        except Exception:
            print("BAD OUTPUT", p.stdout[:200], p.stderr[:200]); time.sleep(1); continue
        err = d.get("error") or {}
        if err.get("code") == 429:
            wait = 2 ** attempt; print(f"429, sleep {wait}s"); time.sleep(wait); continue
        return d
    raise RuntimeError("retry exhausted")

TYPE_MAP = {1:"正式",2:"实习",3:"外包",4:"劳务",5:"顾问"}
GENDER = {1:"男",2:"女"}

def enum_types():
    d = cli("GET /open-apis/contact/v3/employee_type_enums", {"page_size":100})
    m = dict(TYPE_MAP)
    for it in (d.get("data") or {}).get("items") or []:
        try: m[int(it.get("enum_type"))] = it.get("content") or it.get("enum_name","")
        except Exception: pass
    return m

def mask_phone(s):
    # 2026-11-20 用户决定全量导出手机号，不再脱敏
    return s or ""

def status_of(st):
    st = st or {}
    if st.get("is_resigned") or st.get("is_exited"): return "离职"
    if st.get("is_frozen"): return "冻结"
    if not st.get("is_activated"): return "未激活"
    if st.get("is_unjoin"): return "未加入"
    return "在职"

# ---- 1. BFS departments ----
depts = OrderedDict()  # od_id -> {name, parent, chat_id, leaders}
frontier = ["0"]
depth = {("0"):""}
parent = {"0": None}
seen = set()
while frontier:
    nxt = []
    for pid in frontier:
        tok = None
        while True:
            params = {"department_id_type":"open_department_id","page_size":50}
            if tok: params["page_token"] = tok
            path = "GET /open-apis/contact/v3/departments/0/children" if pid=="0" else f"GET /open-apis/contact/v3/departments/{pid}/children"
            d = cli(path, params)
            data = d.get("data") or {}
            for it in data.get("items") or []:
                od = it.get("open_department_id")
                if od in seen or od == pid: continue
                seen.add(od)
                parent[od] = None if pid=="0" else pid
                name = (it.get("i18n_name") or {}).get("zh_cn") or it.get("name") or ""
                depts[od] = {"name": name, "parent": None if pid=="0" else pid,
                             "chat_id": it.get("chat_id",""), "leader": ""}
                nxt.append(od)
            if data.get("has_more") and data.get("page_token"): tok = data["page_token"]; time.sleep(SLEEP)
            else: break
        time.sleep(SLEEP)
    print(f"BFS level done: +{len(nxt)} depts, total {len(depts)}", flush=True)
    frontier = [x for x in nxt if x in depts]  # only enqueue known-new
print(f"departments: {len(depts)}")

# path builder
def path_of(od):
    parts = []
    cur = od if od in depts else None
    while cur:
        parts.append(depts[cur]["name"]); cur = depts[cur]["parent"]
    return "/".join(reversed(parts))

# ---- 2. users per dept (incl root 0) ----
users = {}  # open_id -> record
user_depts = {}  # open_id -> [od,...]
all_od = ["0"] + list(depts.keys())
for i, od in enumerate(all_od):
    tok = None
    while True:
        params = {"department_id": od, "page_size": 50}
        if tok: params["page_token"] = tok
        d = cli("GET /open-apis/contact/v3/users/find_by_department", params)
        data = d.get("data") or {}
        for u in data.get("items") or []:
            oid = u.get("open_id")
            if oid not in users:
                users[oid] = u
                user_depts[oid] = []
            if od not in user_depts[oid]: user_depts[oid].append(od)
        if data.get("has_more") and data.get("page_token"): tok = data["page_token"]; time.sleep(SLEEP)
        else: break
    if i % 10 == 0: print(f"dept {i}/{len(all_od)} users={len(users)}")
    time.sleep(SLEEP)
print(f"users: {len(users)}")

# primary dept per user
prim = {}
for oid, u in users.items():
    pd = None
    for o in u.get("orders") or []:
        if o.get("is_primary_dept"): pd = o.get("department_id"); break
    if not pd and user_depts.get(oid): pd = user_depts[oid][0]
    prim[oid] = pd

# ---- 3. employee_type enum ----
tmap = enum_types()
print("type enum:", len(tmap))

# ---- 4. leader resolution ----
miss = [users[o].get("leader_user_id") for o in users if users[o].get("leader_user_id") and users[o]["leader_user_id"] not in users]
miss = [m for m in miss if m]
for j, lid in enumerate(dict.fromkeys(miss)):
    d = cli("GET /open-apis/contact/v3/users/" + lid, {"user_id_type":"open_id"})
    u = (d.get("data") or {}).get("user") or {}
    if u.get("open_id"):
        users[u["open_id"]] = u  # add leader stub
        user_depts.setdefault(u["open_id"], [])
        prim[u["open_id"]] = None
    time.sleep(SLEEP)
print(f"leader resolve: {len(set(miss))} extra lookups")

def display(oid):
    u = users.get(oid) or {}
    return u.get("name",""), u.get("employee_no","") or ""

headcount = {}
for oid, lst in user_depts.items():
    for od in lst:
        headcount[od] = headcount.get(od, 0) + 1

# ---- 5. write employees csv ----
with open(OUT / f"org_export_employees_{DATE}.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["工号","user_id","open_id","姓名","英文名","性别","部门完整路径","主部门","用工类型","入职日期","工作城市","国家","所属公司","邮箱","企业邮箱","手机号","头衔","状态","直属上级","上级工号","上级open_id"])
    n_row = 0
    for oid, u in users.items():
        if prim.get(oid) == None and oid not in user_depts or not user_depts.get(oid) and prim.get(oid) is None:
            pass
        pd = prim.get(oid)
        dp = path_of(pd) if pd else ""
        dn = depts.get(pd, {}).get("name", "") if pd else ""
        # 公司实体: 按自定义字段 ID 定位, 回退到文本含有限公司/deeproute 的字段
        comp = ""
        for ca in u.get("custom_attrs") or []:
            if ca.get("id") == "C-7197733044367147036":
                comp = ((ca.get("value") or {}).get("text") or "").strip(); break
        if not comp:
            for ca in u.get("custom_attrs") or []:
                t = ((ca.get("value") or {}).get("text") or "")
                if "有限公司" in t or "deeproute" in t: comp = t; break
        jt = u.get("join_time")
        join = time.strftime("%Y-%m-%d", time.gmtime(jt)) if jt else ""
        et = tmap.get(u.get("employee_type"), f"Custom({u.get('employee_type')})" if u.get("employee_type") is not None else "")
        ln, lno = display(u.get("leader_user_id",""))
        w.writerow([u.get("employee_no",""), u.get("user_id",""), oid, u.get("name",""), u.get("en_name",""),
                    GENDER.get(u.get("gender"), ""), dp, dn, et, join,
                    u.get("city",""), u.get("country",""), comp,
                    u.get("email",""), u.get("enterprise_email",""), mask_phone(u.get("mobile","")),
                    u.get("job_title",""), status_of(u.get("status")),
                    ln, lno, u.get("leader_user_id","")])
        n_row += 1
print("employee rows:", n_row)

# ---- 6. write departments csv ----
with open(OUT / f"org_export_departments_{DATE}.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["部门名","open_department_id","父部门","完整路径","直属人数","部门群"])
    for od, info in depts.items():
        pn = depts.get(info["parent"], {}).get("name", "") if info.get("parent") else "(根)"
        w.writerow([info["name"], od, pn, path_of(od), headcount.get(od, 0), info["chat_id"]])
print("dept rows:", len(depts))

# root-level users (department 0) check
root_users = [users[o]["name"] for o in users if "0" in user_depts.get(o, [])]
print("root-dept users:", root_users)
print("DONE ->", OUT)
