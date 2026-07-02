use anyhow::{bail, Result};
use std::collections::HashMap;

use super::models::MenuProfile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GatewayAction {
    Wait,
    SendLine(String),
    Connected,
    Failed(String),
}

pub struct GatewayAutomaton {
    menu: MenuProfile,
    vars: HashMap<String, String>,
    next_step: usize,
}

impl GatewayAutomaton {
    pub fn new(menu: MenuProfile, vars: HashMap<String, String>) -> Self {
        Self {
            menu,
            vars,
            next_step: 0,
        }
    }

    pub fn on_output(&mut self, output: &str) -> Result<GatewayAction> {
        let lower = output.to_lowercase();

        if let Some(pattern) = self
            .menu
            .failure_patterns
            .iter()
            .find(|pattern| lower.contains(&pattern.to_lowercase()))
        {
            return Ok(GatewayAction::Failed(pattern.clone()));
        }

        if self
            .menu
            .success_patterns
            .iter()
            .any(|pattern| output.contains(pattern))
        {
            return Ok(GatewayAction::Connected);
        }

        let Some(step) = self.menu.steps.get(self.next_step) else {
            return Ok(GatewayAction::Wait);
        };

        if lower.contains(&step.expect.to_lowercase()) {
            self.next_step += 1;
            return Ok(GatewayAction::SendLine(resolve_template(
                &step.send, &self.vars,
            )?));
        }

        Ok(GatewayAction::Wait)
    }
}

fn resolve_template(template: &str, vars: &HashMap<String, String>) -> Result<String> {
    if let Some(name) = template
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
    {
        return vars
            .get(name)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing menu variable {name}"));
    }
    if template.contains("${") {
        bail!("only full-value templates are supported");
    }
    Ok(template.to_string())
}
