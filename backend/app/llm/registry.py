from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

ContractMode = Literal["audit", "enforce"]


@dataclass(frozen=True, slots=True)
class LLMPricingSpec:
    input_per_million: float | None = None
    output_per_million: float | None = None
    currency: str = "USD"
    source: str = "pending_verification"


@dataclass(frozen=True, slots=True)
class LLMCapabilitySpec:
    max_output_tokens: int | None = None
    max_context_tokens: int | None = None
    streaming: bool = True
    supports_json_mode: bool | None = None
    supports_tool_calling: bool | None = None
    supports_vision: bool | None = None


@dataclass(frozen=True, slots=True)
class LLMProviderContract:
    key: str
    default_base_url: str | None
    requires_base_url: bool
    allows_unknown_models: bool
    recommended_max_tokens: int
    supported_params: frozenset[str]
    aliases: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class LLMModelContract:
    provider: str
    model: str
    capabilities: LLMCapabilitySpec
    pricing: LLMPricingSpec | None = None
    aliases: frozenset[str] = frozenset()
    prefix_aliases: frozenset[str] = frozenset()

    @property
    def key(self) -> str:
        return model_key(self.provider, self.model)


@dataclass(frozen=True, slots=True)
class LLMContractResolution:
    provider: str
    model: str
    model_key: str
    provider_contract: LLMProviderContract
    model_contract: LLMModelContract | None
    compatibility_alias: str | None = None
    notes: tuple[str, ...] = ()

    @property
    def is_unknown_model(self) -> bool:
        return self.model_contract is None


@dataclass(frozen=True, slots=True)
class BaseUrlResolution:
    provider: str
    base_url: str | None
    used_default: bool
    note: str | None = None


class LLMContractLookupError(ValueError):
    def __init__(self, code: str, *, provider: str | None = None, model: str | None = None, details: dict | None = None):
        self.code = code
        self.provider = str(provider or "").strip() or None
        self.model = str(model or "").strip() or None
        self.details = dict(details or {})
        super().__init__(code)


def _normalize_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in ("http", "https"):
        raise LLMContractLookupError("invalid_base_url_scheme", details={"base_url": value})
    if not parsed.netloc:
        raise LLMContractLookupError("invalid_base_url", details={"base_url": value})
    return normalized


def model_key(provider: str, model: str) -> str:
    return f"{provider.strip()}::{model.strip()}"


PROVIDER_CONTRACTS: tuple[LLMProviderContract, ...] = (
    LLMProviderContract(
        key="openai",
        default_base_url="https://api.openai.com/v1",
        requires_base_url=False,
        allows_unknown_models=False,
        recommended_max_tokens=12000,
        supported_params=frozenset({"temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty", "stop"}),
        aliases=frozenset({"openai-chat"}),
    ),
    LLMProviderContract(
        key="openai_responses",
        default_base_url="https://api.openai.com/v1",
        requires_base_url=False,
        allows_unknown_models=False,
        recommended_max_tokens=12000,
        supported_params=frozenset({"temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty", "stop"}),
        aliases=frozenset({"openai-responses"}),
    ),
    LLMProviderContract(
        key="openai_compatible",
        default_base_url=None,
        requires_base_url=True,
        allows_unknown_models=True,
        recommended_max_tokens=12000,
        supported_params=frozenset({"temperature", "top_p", "max_tokens", "stop"}),
        aliases=frozenset({"openai_compat", "openai-compatible"}),
    ),
    LLMProviderContract(
        key="openai_responses_compatible",
        default_base_url=None,
        requires_base_url=True,
        allows_unknown_models=True,
        recommended_max_tokens=12000,
        supported_params=frozenset({"temperature", "top_p", "max_tokens", "stop"}),
        aliases=frozenset({"openai_responses_compat", "openai-responses-compatible"}),
    ),
    LLMProviderContract(
        key="anthropic",
        default_base_url="https://api.anthropic.com",
        requires_base_url=False,
        allows_unknown_models=False,
        recommended_max_tokens=8192,
        supported_params=frozenset({"temperature", "top_p", "max_tokens", "top_k", "stop"}),
    ),
    LLMProviderContract(
        key="gemini",
        default_base_url="https://generativelanguage.googleapis.com",
        requires_base_url=False,
        allows_unknown_models=False,
        recommended_max_tokens=8192,
        supported_params=frozenset({"temperature", "top_p", "max_tokens", "top_k", "stop"}),
        aliases=frozenset({"google"}),
    ),
    LLMProviderContract(
        key="deepseek",
        default_base_url="https://api.deepseek.com",
        requires_base_url=False,
        allows_unknown_models=True,
        recommended_max_tokens=8192,
        supported_params=frozenset({"temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty", "stop"}),
    ),
)

MODEL_CONTRACTS: tuple[LLMModelContract, ...] = (
    LLMModelContract(
        provider="openai",
        model="gpt-4o-mini",
        aliases=frozenset({"gpt-4o-mini-2024-07-18"}),
        prefix_aliases=frozenset({"gpt-4o-mini"}),
        capabilities=LLMCapabilitySpec(max_output_tokens=16384, max_context_tokens=128000, supports_json_mode=True, supports_tool_calling=True, supports_vision=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai",
        model="gpt-4o",
        aliases=frozenset({"gpt-4o-2024-08-06"}),
        prefix_aliases=frozenset({"gpt-4o"}),
        capabilities=LLMCapabilitySpec(max_output_tokens=16384, max_context_tokens=128000, supports_json_mode=True, supports_tool_calling=True, supports_vision=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai",
        model="gpt-4.1-mini",
        aliases=frozenset({"gpt-4.1-mini-2025-04-14"}),
        capabilities=LLMCapabilitySpec(supports_json_mode=True, supports_tool_calling=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai",
        model="gpt-4.1",
        aliases=frozenset({"gpt-4.1-2025-04-14"}),
        capabilities=LLMCapabilitySpec(supports_json_mode=True, supports_tool_calling=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai",
        model="gpt-4",
        prefix_aliases=frozenset({"gpt-4"}),
        capabilities=LLMCapabilitySpec(max_output_tokens=8192, max_context_tokens=8192, supports_json_mode=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai_responses",
        model="gpt-4o-mini",
        aliases=frozenset({"gpt-4o-mini-2024-07-18"}),
        prefix_aliases=frozenset({"gpt-4o-mini"}),
        capabilities=LLMCapabilitySpec(max_output_tokens=16384, max_context_tokens=128000, supports_json_mode=True, supports_tool_calling=True, supports_vision=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai_responses",
        model="gpt-4o",
        aliases=frozenset({"gpt-4o-2024-08-06"}),
        prefix_aliases=frozenset({"gpt-4o"}),
        capabilities=LLMCapabilitySpec(max_output_tokens=16384, max_context_tokens=128000, supports_json_mode=True, supports_tool_calling=True, supports_vision=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai_responses",
        model="gpt-4.1-mini",
        aliases=frozenset({"gpt-4.1-mini-2025-04-14"}),
        capabilities=LLMCapabilitySpec(supports_json_mode=True, supports_tool_calling=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="openai_responses",
        model="gpt-4",
        prefix_aliases=frozenset({"gpt-4"}),
        capabilities=LLMCapabilitySpec(max_output_tokens=8192, max_context_tokens=8192, supports_json_mode=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="anthropic",
        model="claude-3-7-sonnet-20250219",
        aliases=frozenset({"claude-3-7-sonnet", "claude-3-7-sonnet-latest"}),
        capabilities=LLMCapabilitySpec(supports_json_mode=True, supports_tool_calling=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="gemini",
        model="gemini-2.0-flash",
        aliases=frozenset({"gemini-2.0-flash-exp"}),
        prefix_aliases=frozenset({"gemini-2.0-flash"}),
        capabilities=LLMCapabilitySpec(supports_json_mode=True, supports_tool_calling=True, supports_vision=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="gemini",
        model="gemini-1.5-pro",
        prefix_aliases=frozenset({"gemini-1.5-pro"}),
        capabilities=LLMCapabilitySpec(supports_json_mode=True, supports_tool_calling=True, supports_vision=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="gemini",
        model="gemini-1.5-flash",
        prefix_aliases=frozenset({"gemini-1.5-flash"}),
        capabilities=LLMCapabilitySpec(supports_json_mode=True, supports_tool_calling=True, supports_vision=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="deepseek",
        model="deepseek-chat",
        capabilities=LLMCapabilitySpec(max_output_tokens=8192, max_context_tokens=65536, supports_json_mode=True, supports_tool_calling=True),
        pricing=LLMPricingSpec(),
    ),
    LLMModelContract(
        provider="deepseek",
        model="deepseek-reasoner",
        capabilities=LLMCapabilitySpec(max_output_tokens=16384, max_context_tokens=65536, supports_json_mode=False, supports_tool_calling=False),
        pricing=LLMPricingSpec(),
    ),
)

PROVIDER_BY_KEY = {item.key: item for item in PROVIDER_CONTRACTS}
PROVIDER_ALIAS_TO_KEY = {alias: item.key for item in PROVIDER_CONTRACTS for alias in item.aliases}
MODELS_BY_PROVIDER: dict[str, tuple[LLMModelContract, ...]] = {}
for _item in MODEL_CONTRACTS:
    MODELS_BY_PROVIDER.setdefault(_item.provider, []).append(_item)
MODELS_BY_PROVIDER = {provider: tuple(items) for provider, items in MODELS_BY_PROVIDER.items()}


def normalize_provider(provider: str) -> str:
    provider_norm = str(provider or "").strip()
    if not provider_norm:
        raise LLMContractLookupError("provider_required")
    if provider_norm in PROVIDER_BY_KEY:
        return provider_norm
    mapped = PROVIDER_ALIAS_TO_KEY.get(provider_norm)
    if mapped is not None:
        return mapped
    raise LLMContractLookupError("unsupported_provider", provider=provider_norm, details={"provider": provider_norm})


def provider_contract(provider: str) -> LLMProviderContract:
    return PROVIDER_BY_KEY[normalize_provider(provider)]


def resolve_llm_contract(provider: str, model: str, *, mode: ContractMode = "audit") -> LLMContractResolution:
    provider_key = normalize_provider(provider)
    provider_meta = PROVIDER_BY_KEY[provider_key]
    model_norm = str(model or "").strip()
    if not model_norm:
        raise LLMContractLookupError("model_required", provider=provider_key)

    for contract in MODELS_BY_PROVIDER.get(provider_key, ()):  # exact + aliases
        if model_norm == contract.model:
            return LLMContractResolution(provider=provider_key, model=contract.model, model_key=contract.key, provider_contract=provider_meta, model_contract=contract)
        if model_norm in contract.aliases:
            return LLMContractResolution(
                provider=provider_key,
                model=contract.model,
                model_key=contract.key,
                provider_contract=provider_meta,
                model_contract=contract,
                compatibility_alias=model_norm,
                notes=("compatibility_alias",),
            )
        if any(model_norm.startswith(prefix + "-") for prefix in contract.prefix_aliases):
            return LLMContractResolution(
                provider=provider_key,
                model=contract.model,
                model_key=contract.key,
                provider_contract=provider_meta,
                model_contract=contract,
                compatibility_alias=model_norm,
                notes=("prefix_alias",),
            )

    if mode == "enforce" and not provider_meta.allows_unknown_models:
        raise LLMContractLookupError(
            "unsupported_model",
            provider=provider_key,
            model=model_norm,
            details={"provider": provider_key, "model": model_norm, "mode": mode},
        )

    note = "gateway_passthrough" if provider_meta.allows_unknown_models else "unregistered_model"
    return LLMContractResolution(
        provider=provider_key,
        model=model_norm,
        model_key=model_key(provider_key, model_norm),
        provider_contract=provider_meta,
        model_contract=None,
        notes=(note,),
    )


def canonical_model_key(provider: str, model: str, *, mode: ContractMode = "audit") -> str:
    return resolve_llm_contract(provider, model, mode=mode).model_key


def resolve_base_url(provider: str, base_url: str | None, *, mode: ContractMode = "audit") -> BaseUrlResolution:
    provider_meta = provider_contract(provider)
    raw = str(base_url or "").strip() or None
    if raw:
        return BaseUrlResolution(provider=provider_meta.key, base_url=_normalize_base_url(raw), used_default=False)
    if provider_meta.default_base_url:
        return BaseUrlResolution(provider=provider_meta.key, base_url=_normalize_base_url(provider_meta.default_base_url), used_default=True)
    if mode == "enforce":
        raise LLMContractLookupError("base_url_required", provider=provider_meta.key, details={"provider": provider_meta.key})
    return BaseUrlResolution(provider=provider_meta.key, base_url=None, used_default=False, note="missing_base_url")


def max_output_tokens_limit(provider: str, model: str | None, *, mode: ContractMode = "audit") -> int | None:
    if model is None:
        return None
    try:
        contract = resolve_llm_contract(provider, model, mode=mode).model_contract
    except LLMContractLookupError:
        return None
    return contract.capabilities.max_output_tokens if contract is not None else None


def max_context_tokens_limit(provider: str, model: str | None, *, mode: ContractMode = "audit") -> int | None:
    if model is None:
        return None
    try:
        contract = resolve_llm_contract(provider, model, mode=mode).model_contract
    except LLMContractLookupError:
        return None
    return contract.capabilities.max_context_tokens if contract is not None else None


def recommended_max_tokens(provider: str, model: str | None, *, mode: ContractMode = "audit") -> int:
    provider_meta = provider_contract(provider)
    if model is None:
        return provider_meta.recommended_max_tokens
    limit = max_output_tokens_limit(provider, model, mode=mode)
    if isinstance(limit, int) and limit > 0:
        return min(provider_meta.recommended_max_tokens, limit)
    return provider_meta.recommended_max_tokens


def pricing_contract(provider: str, model: str | None, *, mode: ContractMode = "audit") -> LLMPricingSpec | None:
    if model is None:
        return None
    try:
        contract = resolve_llm_contract(provider, model, mode=mode).model_contract
    except LLMContractLookupError:
        return None
    return contract.pricing if contract is not None else None


def supported_params(provider: str) -> frozenset[str]:
    return provider_contract(provider).supported_params
