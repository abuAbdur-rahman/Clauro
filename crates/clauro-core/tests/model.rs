//! Task 005 — `ModelRef` / `ModelLimits` shapes (RED).
//!
//! Names `ProviderAdapter.limits` but defines nothing (`CONTRACTS.md` §5); the
//! picker consumes the `models.dev` subset. Identity is provider key +
//! model id; an unknown model degrades to a typed notice, never zero limits.

use clauro_core::{ModelLimits, ModelRef, UnknownModel};

#[test]
fn ref_carries_provider_key_and_id() {
    let r = ModelRef {
        provider: "anthropic".to_string(),
        id: "claude-x".to_string(),
    };
    assert_eq!(r.provider, "anthropic");
    assert_eq!(r.id, "claude-x");
}

#[test]
fn limits_serialise_to_catalogue_keys() {
    let json = serde_json::to_value(ModelLimits {
        context_window: 200_000,
        max_output: 8_192,
        reasoning: true,
        tool_call: true,
    })
    .expect("limits must serialise");
    assert_eq!(json["contextWindow"], 200_000);
    assert_eq!(json["maxOutput"], 8_192);
    assert_eq!(json["reasoning"], true);
    assert_eq!(json["tool_call"], true);
}

#[test]
fn unknown_model_is_typed_never_zero() {
    let u = UnknownModel::for_ref(ModelRef {
        provider: "third-party".to_string(),
        id: "mystery-1".to_string(),
    });
    assert_eq!(u.kind, "unknown-model");
    assert_eq!(u.model.id, "mystery-1");
}
