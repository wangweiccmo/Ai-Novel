# 新建项目流程优化：更符合小白直觉

## 现状分析

### 当前"新建项目"全流程

1. **Dashboard 页** (`/`) → 点击"+" 新建项目卡片
2. **弹窗创建** → Modal 表单：项目名（必填）、类型（可选）、一句话梗概（可选）→ 创建后跳转到 `/projects/:id/settings`
3. **项目设置页** (`/settings`) → 填写世界观、风格、约束 → 保存
4. **角色卡** (`/characters`) → 创建角色
5. **模型配置** (`/prompts`) → 配置 API Key + 选择模型 + 测试连接
6. **大纲** (`/outline`) → AI 生成或手写大纲
7. **章节骨架** → 从大纲创建章节
8. **写作** → 逐章 AI 生成/编辑

另外还有 **模板创建**（直接在 Dashboard 选模板一键创建）和 **开工向导** (wizard 页) 两个辅助路径。

### 当前痛点（小白视角）

| # | 问题 | 原因 |
|---|------|------|
| 1 | **创建弹窗过于简陋** | 只有"项目名/类型/梗概"3 个字段，小白不知道要填什么，也不知道这些对后面有什么影响 |
| 2 | **创建后直接跳到设置页，断裂感强** | 创建完了突然到了一个"世界观/风格/约束"页面，小白还没思路，容易懵 |
| 3 | **模板和新建是平行入口，发现性差** | 模板区块在 Dashboard 下方，新用户可能直接点"+"就进了空项目 |
| 4 | **向导页和设置页功能重复** | 向导(wizard)承载的是"步骤检查 + 一键开工"，但它和设置页的"下一步"按钮功能重叠 |
| 5 | **关键步骤"配置模型"太深** | 必须到 Prompts 页才能配 API Key + 测试，小白不知道这是什么 |
| 6 | **步骤清单信息密度高** | wizard 页列了 8 个步骤 + 跳过按钮 + 自动开工，信息量大 |

---

## 优化方案

### 核心理念
> **把"新建项目"从一个弹窗升级为分步引导（Stepper），让小白在创建过程中把最关键的信息一次性填完，创建完直接能用。**

### 方案概览

将现有的"创建弹窗 + 跳设置页 + 跳模型页"合并成一个 **分步表单（Stepper Dialog）**，分 3 步，在 Modal 中完成：

```
步骤 1：基本信息      →   步骤 2：创作设定      →   步骤 3：模型配置
─────────────────     ─────────────────────     ─────────────────────
· 项目名 *            · 世界观                  · 选择已有配置
· 题材（快捷标签）     · 风格                    · 或新建（provider + model + API Key）
· 一句话梗概           · 约束                    · 测试连接
· [可选] 选模板快填     · [模板预填提示]            · [跳过，稍后配置]
```

完成后 → 创建项目 → 自动保存设置 + 绑定模型 → 跳转到 **开工向导页**（而非设置页）

### 详细设计

#### 1. 新建 `CreateProjectStepper` 组件

**文件：** `frontend/src/components/project/CreateProjectStepper.tsx`

- 一个独立的模态组件，接收 `open` / `onClose` / `onCreated` props
- 内部管理 3 个步骤的表单状态
- 步骤指示条（Step 1 · 2 · 3）可视化当前进度

**Step 1 — 基本信息：**
- 项目名（input，必填）
- 题材（预设标签选择 + 自定义输入）
  - 标签示例：`都市` `奇幻` `科幻` `言情` `悬疑` `历史` `其他`
  - 点击标签自动填入，也可手动输入
- 一句话梗概（textarea，可选，带 placeholder 提示）
- 底部：从模板快速填充（折叠区，展开可选 4 个模板）
  - 选择模板后自动填充 Step 1 + Step 2 的所有字段

**Step 2 — 创作设定：**
- 世界观（textarea，带 placeholder 提示"例如：现代都市，互联网时代..."）
- 风格（textarea，带 placeholder 提示"例如：节奏紧凑，对白有张力..."）
- 约束（textarea，带 placeholder 提示"例如：总字数 10 万字，每章 3000 字..."）
- 顶部提示：*"这些内容会影响 AI 生成的质量，建议尽量具体。不确定的话可以先跳过，之后在「项目设置」里补充。"*
- 底部：可"跳过此步"

**Step 3 — 模型配置：**
- 如果用户已有 LLM Profile（已配过模型）：
  - 显示已有配置列表，可选择绑定
  - 或新建一个
- 如果用户没有任何 Profile：
  - 简化的配置表单：Provider 选择 + API Key + Model 选择
  - "测试连接"按钮
- 底部：可"跳过，稍后配置"（明确提示：不配模型无法使用 AI 生成）

**完成时：**
1. POST `/api/projects` 创建项目
2. PUT `/api/projects/:id/settings` 保存设定
3. 如果配置了模型，绑定 `llm_profile_id`
4. 跳转到 `/projects/:id/wizard`

#### 2. 改造 Dashboard 页

**文件：** `frontend/src/pages/DashboardPage.tsx`

修改点：
- "+" 按钮和"创建第一个项目"按钮改为打开 `CreateProjectStepper`（替代原有的简单 Modal）
- 模板区域保留，但模板点击也改为打开 `CreateProjectStepper` 并预填模板数据
- 删除原有的简单创建 Modal（`<Modal open={createOpen}>`）

#### 3. 优化 Wizard 页的首屏体验

**文件：** `frontend/src/pages/ProjectWizardPage.tsx`

修改点：
- 如果 wizard 检测到"模型未配置"，在"从这里开始"区块顶部增加醒目提示：
  > ⚠️ 还没配置 AI 模型 → [立即配置]
- 简化"从这里开始"区域：
  - "按步骤推荐"保持
  - "快速开工"只在模型配置完成后才显示为可用态

### 不改动的部分
- 后端 API 不做改动（前端组合调用即可）
- SettingsPage 保持现状（作为详细编辑入口）
- WizardNextBar 保持现状
- 路由结构不变
- wizard.ts 的进度计算逻辑不变

---

## 涉及的文件

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `frontend/src/components/project/CreateProjectStepper.tsx` | 分步创建组件 |
| 修改 | `frontend/src/pages/DashboardPage.tsx` | 替换创建弹窗，改为使用 Stepper |
| 修改 | `frontend/src/pages/ProjectWizardPage.tsx` | 优化首屏，增加模型未配置提示 |

## 实施步骤

1. 创建 `CreateProjectStepper` 组件（Step 1 → 2 → 3 分步表单）
2. 改造 DashboardPage，替换创建入口
3. 优化 ProjectWizardPage 首屏
4. 确保 TypeScript 编译通过 + lint 通过
