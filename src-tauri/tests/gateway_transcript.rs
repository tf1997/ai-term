use ai_term_lib::gateway::{GatewayAction, GatewayAutomaton};
use ai_term_lib::models::{MenuProfile, MenuStep};
use std::collections::HashMap;

fn menu() -> MenuProfile {
    MenuProfile {
        id: "company-default".into(),
        name: "Company Default".into(),
        steps: vec![
            MenuStep {
                expect: "personal username".into(),
                send: "${gateway.username}".into(),
            },
            MenuStep {
                expect: "server ip".into(),
                send: "${target.host}".into(),
            },
            MenuStep {
                expect: "server user".into(),
                send: "${target.username}".into(),
            },
        ],
        success_patterns: vec!["Last login".into(), "$ ".into()],
        failure_patterns: vec!["Permission denied".into()],
    }
}

fn vars() -> HashMap<String, String> {
    HashMap::from([
        ("gateway.username".into(), "company.user".into()),
        ("target.host".into(), "10.12.8.21".into()),
        ("target.username".into(), "app".into()),
    ])
}

#[test]
fn sends_values_in_prompt_order() {
    let mut automaton = GatewayAutomaton::new(menu(), vars());

    assert_eq!(
        automaton.on_output("Input personal username:").unwrap(),
        GatewayAction::SendLine("company.user".into())
    );
    assert_eq!(
        automaton.on_output("Input server ip:").unwrap(),
        GatewayAction::SendLine("10.12.8.21".into())
    );
    assert_eq!(
        automaton.on_output("Input server user:").unwrap(),
        GatewayAction::SendLine("app".into())
    );
    assert_eq!(
        automaton.on_output("Last login: Wed Jul 1").unwrap(),
        GatewayAction::Connected
    );
}

#[test]
fn failure_pattern_stops_automation() {
    let mut automaton = GatewayAutomaton::new(menu(), vars());

    assert_eq!(
        automaton
            .on_output("Permission denied, please try again")
            .unwrap(),
        GatewayAction::Failed("Permission denied".into())
    );
}
