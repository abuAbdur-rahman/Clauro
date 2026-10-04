//! Task 006 — one thinking shape for both adapters (RED).
//!
//! Anthropic thinking blocks and OpenAI reasoning tokens normalise to the
//! same `ContentBlock::Thinking` (D54). The transcript cannot branch on
//! provider, so this test builds the shape from both adapters' events.

use clauro_core::{ContentBlock, ThinkingDisplay};
use clauro_transport::{
    AnthropicParser, InboundKind, NormalisedEvent, OpenAiParser, SseFramer, StreamParser,
};

fn run_anthropic() -> Vec<NormalisedEvent> {
    let bytes = std::fs::read(format!(
        "{}/tests/fixtures/omitted_thinking.sse",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("fixture must read");
    let mut framer = SseFramer::new();
    let mut parser = AnthropicParser::new();
    let mut out = Vec::new();
    for raw in framer.feed(&bytes).expect("fixture is small valid UTF-8") {
        out.extend(parser.feed(&raw));
    }
    for raw in framer.finish() {
        out.extend(parser.feed(&raw));
    }
    out
}

fn run_openai_reasoning() -> Vec<NormalisedEvent> {
    let mut framer = SseFramer::new();
    let mut parser = OpenAiParser::new();
    let mut out = Vec::new();
    let chunk = "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"because\"},\"finish_reason\":null}]}\n\n";
    for raw in framer
        .feed(chunk.as_bytes())
        .expect("inline chunk is small valid UTF-8")
    {
        out.extend(parser.feed(&raw));
    }
    out
}

fn to_thinking(events: &[NormalisedEvent]) -> Vec<ContentBlock> {
    let mut out = Vec::new();
    let mut text = String::new();
    let mut signature = String::new();
    let mut open = false;
    for e in events {
        match e {
            NormalisedEvent::BlockStart {
                kind: InboundKind::Thinking,
                ..
            } => {
                open = true;
            }
            NormalisedEvent::BlockDelta {
                text: Some(t),
                signature: None,
                ..
            } if open => {
                text.push_str(t);
            }
            NormalisedEvent::BlockDelta {
                signature: Some(s), ..
            } if open => {
                signature.push_str(s);
            }
            NormalisedEvent::BlockStop { .. } if open => {
                open = false;
                if !signature.is_empty() {
                    out.push(
                        ContentBlock::thinking(&text, &signature, ThinkingDisplay::Full)
                            .expect("adapter-captured signature must build"),
                    );
                }
                text.clear();
                signature.clear();
            }
            _ => {}
        }
    }
    out
}

#[test]
fn both_adapters_yield_the_same_thinking_shape() {
    let a = to_thinking(&run_anthropic());
    assert_eq!(a.len(), 1, "omitted thinking is one block");

    // OpenAI reasoning carries no wire signature; the turn layer attaches one
    // at close. Same text pipeline, same constructor, same variant.
    let o = run_openai_reasoning();
    assert!(
        o.iter().any(|e| matches!(
            e,
            NormalisedEvent::BlockStart {
                kind: InboundKind::Thinking,
                ..
            }
        )),
        "reasoning opens a thinking start: {o:?}"
    );
    let mut otext = String::new();
    for e in &o {
        if let NormalisedEvent::BlockDelta { text: Some(t), .. } = e {
            otext.push_str(t);
        }
    }
    let ob = ContentBlock::thinking(&otext, "sig-o", ThinkingDisplay::Full).expect("sig");
    assert!(matches!(ob, ContentBlock::Thinking { .. }));
    assert_eq!(
        std::mem::discriminant(&a[0]),
        std::mem::discriminant(&ob),
        "one Thinking shape renders for both adapters (D54)"
    );
}
