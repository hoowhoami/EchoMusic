use crate::{
    find_in_xml,
    scpd::{StateVariable, StateVariableKind},
    utils, Error, Result,
};
use roxmltree::Node;
use std::{fmt, rc::Rc};

/// An SCPD action.
/// The action consists of its name used in the services
/// [`action`](../struct.Service.html#method.action) function and a List of
/// [`Argument`](struct.Argument.html)s
#[derive(Debug, Clone)]
pub struct Action {
    name: String,
    arguments: Vec<Argument>,
}
impl fmt::Display for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}(", self.name())?;

        for e in self.input_arguments().take(1) {
            write!(f, "{e}")?;
        }
        for e in self.input_arguments().skip(1) {
            write!(f, ", {e}")?;
        }
        write!(f, ")")?;

        let mut output_arguments = self.output_arguments();
        if let Some(arg) = output_arguments.next() {
            write!(f, " -> ({arg}")?;
            for arg in output_arguments {
                write!(f, ", {arg}")?;
            }
            write!(f, ")")?;
        }

        Ok(())
    }
}

impl Action {
    pub(crate) fn from_xml(
        node: Node<'_, '_>,
        state_variables: &[Rc<StateVariable>],
    ) -> Result<Self> {
        #[allow(non_snake_case)]
        let (name, arguments) = find_in_xml! { node => name, ?argumentList };

        let arguments = arguments
            .map(|args| {
                args.children()
                    .filter(Node::is_element)
                    .map(|node| Argument::from_xml(node, state_variables))
                    .collect::<Result<_>>()
            })
            .transpose()?
            .unwrap_or_default();

        Ok(Self {
            name: utils::parse_node_text(name)?,
            arguments,
        })
    }

    pub fn name(&self) -> &String {
        &self.name
    }

    pub fn input_arguments(&self) -> impl Iterator<Item = &Argument> {
        self.arguments.iter().filter(|a| a.is_input())
    }
    pub fn output_arguments(&self) -> impl Iterator<Item = &Argument> {
        self.arguments.iter().filter(|a| a.is_output())
    }
}

/// Every argument has its associated [`StateVariable`](struct.StateVariable.html), which contains
/// more information about its possible values/range/etc.
#[derive(Debug, Clone)]
pub struct Argument {
    name: String,
    // if not input, it is an output
    is_input: bool,
    state_var: Rc<StateVariable>,
}
impl fmt::Display for Argument {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: ", &self.name)?;

        match self.state_var.kind() {
            StateVariableKind::Simple(datatype) => write!(f, "{datatype}")?,
            StateVariableKind::Enum(variants) => {
                write!(f, "[{}]", variants.join(", "))?;
            }
            StateVariableKind::Range(range) => write!(f, "{range}")?,
        }

        if let Some(default) = self.state_var.default() {
            write!(f, " = {default}")?;
        }

        Ok(())
    }
}

impl Argument {
    fn from_xml(node: Node<'_, '_>, state_variables: &[Rc<StateVariable>]) -> Result<Self> {
        #[allow(non_snake_case)]
        let (name, direction, related_statevar) =
            find_in_xml! { node => name, direction, relatedStateVariable };

        let related_statevar = related_statevar
            .text()
            .ok_or_else(|| Error::ParseError("`relatedStateVariable` is empty"))?;

        let state_var = state_variables
            .iter()
            .find(|sv| sv.name().eq_ignore_ascii_case(related_statevar))
            .ok_or_else(|| Error::ParseError("found argument without related state variable"))?
            .clone();

        let direction = direction.text().unwrap_or_default().to_ascii_lowercase();
        let is_input = match direction.as_str() {
            "in" => Ok(true),
            "out" => Ok(false),
            _ => Err(Error::invalid_response(ParseDirectionErr(direction))),
        }?;

        Ok(Self {
            name: utils::parse_node_text(name)?,
            is_input,
            state_var,
        })
    }
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn is_input(&self) -> bool {
        self.is_input
    }
    pub fn is_output(&self) -> bool {
        !self.is_input
    }

    pub fn related_state_variable(&self) -> &Rc<StateVariable> {
        &self.state_var
    }
}

#[derive(Debug)]
pub struct ParseDirectionErr(String);
impl std::fmt::Display for ParseDirectionErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid direction: `{}`", &self.0)
    }
}
impl std::error::Error for ParseDirectionErr {}
