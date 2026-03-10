from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class LLMTaskCatalogItem:
    key: str
    label: str
    group: str
    description: str
    recommended_provider: str | None = None
    recommended_model: str | None = None
    recommended_note: str | None = None
    cost_tier: str | None = None


LLM_TASK_CATALOG: tuple[LLMTaskCatalogItem, ...] = (
    LLMTaskCatalogItem(
        key="chapter_generate",
        label="章节生成",
        group="writing",
        description="正文生成主流程",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="默认均衡：质量/速度/成本",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="plan_chapter",
        label="章节规划",
        group="writing",
        description="章节前置规划与结构化输出",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="轻量规划优先",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="post_edit",
        label="章节润色",
        group="writing",
        description="章节后处理润色",
        recommended_provider="openai",
        recommended_model="gpt-4o",
        recommended_note="偏质量优先（更稳定的润色）",
        cost_tier="medium",
    ),
    LLMTaskCatalogItem(
        key="content_optimize",
        label="正文优化",
        group="writing",
        description="章节内容优化与压缩改写",
        recommended_provider="openai",
        recommended_model="gpt-4o",
        recommended_note="压缩/改写质量优先",
        cost_tier="medium",
    ),
    LLMTaskCatalogItem(
        key="outline_generate",
        label="大纲生成",
        group="planning",
        description="大纲生成与填充缺失章节",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="中等复杂度",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="chapter_analyze",
        label="章节分析",
        group="analysis",
        description="章节分析结构化输出",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="分析稳定性优先",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="chapter_rewrite",
        label="章节重写",
        group="analysis",
        description="章节重写与修订",
        recommended_provider="openai",
        recommended_model="gpt-4o",
        recommended_note="改写质量优先",
        cost_tier="medium",
    ),
    LLMTaskCatalogItem(
        key="memory_update",
        label="记忆更新提议",
        group="memory",
        description="memory_update JSON 变更提议",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="结构化输出优先",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="worldbook_auto_update",
        label="世界书自动更新",
        group="memory",
        description="世界书后台自动更新任务",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="低成本后台任务",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="characters_auto_update",
        label="角色卡自动更新",
        group="memory",
        description="角色卡后台自动更新任务",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="低成本后台任务",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="graph_auto_update",
        label="图谱自动更新",
        group="memory",
        description="图谱关系后台自动更新任务",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="结构化更新优先",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="table_ai_update",
        label="数值表自动更新",
        group="memory",
        description="数值表后台自动更新任务",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="低成本表格抽取",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="plot_auto_update",
        label="剧情记忆自动更新",
        group="memory",
        description="剧情记忆后台自动更新任务",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="自动抽取稳定优先",
        cost_tier="low",
    ),
    LLMTaskCatalogItem(
        key="fractal_v2",
        label="分形摘要 v2",
        group="memory",
        description="Fractal v2 LLM 摘要任务",
        recommended_provider="openai",
        recommended_model="gpt-4o-mini",
        recommended_note="摘要稳定性优先",
        cost_tier="low",
    ),
)

LLM_TASK_KEY_SET: frozenset[str] = frozenset(item.key for item in LLM_TASK_CATALOG)
LLM_TASK_BY_KEY: dict[str, LLMTaskCatalogItem] = {item.key: item for item in LLM_TASK_CATALOG}


def is_supported_llm_task(task_key: str) -> bool:
    return str(task_key or "").strip() in LLM_TASK_KEY_SET


def llm_task_label(task_key: str) -> str:
    item = LLM_TASK_BY_KEY.get(str(task_key or "").strip())
    return item.label if item is not None else str(task_key or "").strip()
