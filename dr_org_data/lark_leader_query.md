# lark-cli 批量获取员工直属上级（leader_user_id）方法

> Onboard Infra Bot 参与贡献 🐨
> 验证日期: 2026-11-20 · 验证人: 小诺（Onboard Infra Bot）· 提出人: Yanqing Wang

## 背景

2026-11-19 首次尝试失败：bot 身份 `contact +get-user` 返回的 `leader_user_id` 为空，user 身份查同事报 41050/Permission denied（App Owner 可见范围限制）。
2026-11-20 管理员开通权限后重测，**bot 身份全链路打通**。关键权限申请由用户在飞书管理后台完成（contact 相关读取 scope + 通讯录可见范围）。

## 结论

**可行。** bot 身份即可拿到全公司「人 → 直属上级」映射，无需用户 OAuth。

## 已验证命令（全部 `--as bot`）

### 1. 单人查直属上级

```bash
lark-cli contact +get-user --user-id ou_xxx --as bot
# 返回字段: leader_user_id, name, department_ids, orders, user_id, union_id ...
```

验证样本（2026-11-20）:
- Yanqing Wang (ou_f6ed5c534e1fc37574b50ff759f4f263) → leader = Jiaqi Li (ou_4ad4096ea2955a4970d88a27041a98a5)
- Wei Wang (ou_093af42f5f01143880ece16190797759) → leader = Zhuansheng Wang (ou_9bc54d8877687667f5641c57289cd187)
- leader 的 open_id 可继续用同一命令反查 → 支持沿汇报链向上追溯（如 leader 再往上 = 大老板）

### 2. 按部门批量拉成员（「所有人」的正解）

```bash
lark-cli api GET /open-apis/contact/v3/users/find_by_department --as bot \
  --params '{"department_id":"od_xxx","page_size":50}'
```

- 返回 items[] 每个成员都带 `leader_user_id`，一个部门一次调用
- 分页: 响应 `has_more=true` 时带 `page_token`，追加 `--params '{"page_token":"..."}'`

### 3. 部门树遍历

```bash
# 根部门下的子部门列表
lark-cli api GET /open-apis/contact/v3/departments/0/children --as bot \
  --params '{"page_size":50}'
# 任一部门的子部门（递归下去就是全公司部门树）
lark-cli api GET /open-apis/contact/v3/departments/od_xxx/children --as bot \
  --params '{"page_size":50}'
```

- 注意: 用 `open_department_id`（od- 前缀）而非自定义 department_id
- 部门条目含 name/i18n_name、leaders（类型区分主/副）、department_chat_id

## 全公司汇总流程（千人规模预估几分钟）

1. 从 `departments/0/children` 递归 BFS 全部部门节点
2. 每个部门调 `find_by_department`（带分页）拉成员
3. 按用户 `user_id`/`open_id` 去重（一人可能挂多部门）
4. 汇总输出: 姓名 | open_id | 主部门 | leader_open_id
5. 收集全部 leader open_id，再反查一轮转姓名（可对已抓取的全量 map 先查本地，miss 的才调 API）
6. 导出 CSV/飞书表格

## 每人可列字段清单（2026-11-20 二轮授权后实测）

- 标识: name/en_name、user_id(工号系统ID)、open_id、union_id、employee_no(如 ZGBJ801)
- 组织: department_ids + orders(主部门/排序)、leader_user_id(直属上级)
- 用工: employee_type(1正式/2实习/3外包/4劳务/5顾问)、join_time(入职时间戳)、status(is_activated/exited/frozen/resigned)、work_station
- 联系: email、mobile(+86原值)、mobile_visible、city/country
- 其他: gender、job_title(名片头衔,多数为空)、description(签名)、avatar、custom_attrs(管理后台自定义字段,如所属公司)
- 未批到: job_level(职级)、job_family(职序列)、dotted_line_leader(虚线上级) — 返回里无这三个字段
- 部门树字段: name/i18n_name、leaders、chat_id、open_department_id

## 全公司结构导出实施计划（2026-11-20 定稿，CSV-only）

用户决策: 不要飞书在线表格，只存 CSV。手机号首轮脱敏导出，同日用户要求改为全量不脱敏（export.py 已固化 mask_phone=透传）。

### 输出物（落 ~/.agents/tmp_workspaces/org_export_<日期>/）
1. `org_export_employees_<日期>.csv` — 全员明细，UTF-8-BOM（Excel 双击不乱码）
2. `org_export_departments_<日期>.csv` — 部门树

### 列定义（员工 CSV）
employee_no 工号(子公司可能空) | user_id | open_id | name 姓名 | en_name | gender(1男/2女→中文) | dept_path 主部门完整路径(自拼) | dept_name 主部门名 | employee_type 枚举数字→名称(自定义枚举调 employee_type_enum 接口翻译, 拿不到则 "Custom(N)") | join_time 入职日期(秒→YYYY-MM-DD) | city | country | company_entity(取 custom_attrs 第一个 TEXT 值, 即所属公司实体) | email | enterprise_email | mobile 脱敏 | job_title | status(激活/冻结/离职/未激活 归纳) | leader_name 直属上级姓名(反查) | leader_user_no 上级工号 | leader_open_id

### 列定义（部门 CSV）
dept_name | open_department_id | parent_name | full_path | depth | leader_user_id(部门详情接口拿, 失败留空) | dept_chat_id | direct_headcount(直属人数)

### 执行步骤（python 脚本 + lark-cli subprocess, --as bot）
1. BFS 部门树: 从 `departments/0/children` 逐层 `departments/<od_x>/children`（不用 fetch_child=true，因为需要父子关系拼路径），记 parent_map + 每层去重
2. 人员: 每个部门 `users/find_by_department`（page_size=50, has_more→page_token 循环）+ 根部门 department_id=0 也拉一遍；按 open_id 去重（一人多部门保留主部门路径）
3. leader 反查: 先用已抓取的 open_id→(name, employee_no) map 本地解析，miss 的才逐个 +get-user
4. 用工类型枚举: `GET /contact/v3/employee_type_enum` 翻译（无权限则 fallback 内置 1-5 + Custom(N)）
5. 手机号脱敏: 正则保前3后4中间****
6. 限流: 接口上限 1000/min & 50/s，脚本每次调用 sleep 0.15s，429 退避重试
7. 落盘后校验: 行数 vs 去重人数一致、leader 反查 miss 率、抽查样本对照

### 已知数据口径
- 员工 leader_user_id 在 open_id 请求下返回 open_id；用 --user-id-type user_id 查询时返回 user_id —— 脚本统一用 open_id 请求，map 用 open_id 键
- 子公司员工: employee_no 可能为空、employee_type 可能为自定义枚举值(实测见过 6)、邮箱为子域名(yz.deeproute.ai)
- 部门 leaders 字段在 children 接口不带回 ID，部门负责人要另调部门详情接口

## 以后如何重新跑（一键复现）

脚本已固化: `~/.openclaw/workspace/scripts/lark_org_export.py`（对 bot 权限生效即可用，无需 auth login）

```bash
# 一键重跑（脚本自动用运行日做日期和目录，无需改代码），约 5-8 分钟:
python3 ~/.openclaw/workspace/scripts/lark_org_export.py
# 产物: ~/.agents/tmp_workspaces/org_export_<运行日>/org_export_{employees,departments}_<运行日>.csv（UTF-8-BOM）
# 校验看脚本尾部输出: users 总数 / leader resolve / rows 数
```

要点提醒:
- 手机号当前为全量透传（用户 2026-11-20 决策），如需脱敏改 mask_phone() 恢复正则
- 权限前置: bot 的 contact scope + 通讯录全量授权范围（已批，见前文清单）；若哪天 leader 字段变空，先查权限/授权范围是否被收窄
- strict-mode bot 下不要用 --as user，全部走 bot

## 注意事项

- **strict-mode bot**: 当前 lark-cli 配置为 strict mode "bot"，user 身份命令全部被拒（identity_not_supported）。所有 contact 读取走 `--as bot` 即可，不要切 strict mode
- **限流**: 通讯录 OpenAPI 约 1000 次/分钟量级，批量脚本注意 QPS，429 时退避重试
- **leader_user_id 是 open_id**（ou- 前缀），报表需反查姓名；leader 可能为空（顶部老板/外部账号）
- **跨租户用户** is_cross_tenant=true 时多数业务字段为空，做空值兜底
- **权限依赖**: bot 需要通讯录读取 scope（contact:user.base:readonly 等）+ 管理后台把应用加入通讯录授权范围。若再遇 leader_user_id 为空/41050，先查这两处
- MCP 侧对照: `feishu_search_user`（按姓名搜，返回不含 leader）；`feishu_get_user` 未见 leader 字段 → lark-cli bot 路径是拿到 leader 的唯一已验证通道
