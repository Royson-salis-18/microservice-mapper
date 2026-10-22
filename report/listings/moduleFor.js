/** A project with no workflow of its own gets the generic one, rather than a refusal. */
const moduleFor = (id) => TARGETS[id] || generic;

