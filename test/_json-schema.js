// A tiny JSON-schema validator for the subset checkSchema / claimSchema emit (no dependency): type (incl. integer), enum, properties,
// required, additionalProperties false, items, minItems, maxItems, minLength, maxLength, minimum, minProperties, propertyNames.pattern,
// anyOf, additionalProperties as a schema. Anything else in a schema is an error in the test (so an emitted keyword is never ignored).
const KNOWN = new Set(["type", "enum", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "minProperties", "propertyNames", "anyOf", "description", "pattern"]);

/** @returns {string[]} the errors (empty = valid) */
export function validate(schema, value, path = "$") {
  const errs = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`validator does not know keyword ${k} at ${path}`);
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => validate(s, value, path).length === 0)) errs.push(`${path}: matches no anyOf branch`);
    return errs;
  }
  const t = schema.type;
  const isObj = value !== null && typeof value === "object" && !Array.isArray(value);
  if (t === "integer" ? !Number.isInteger(value) : t === "number" ? typeof value !== "number" || !Number.isFinite(value) : t === "string" ? typeof value !== "string" : t === "boolean" ? typeof value !== "boolean" : t === "array" ? !Array.isArray(value) : t === "object" ? !isObj : false) {
    errs.push(`${path}: not ${t}`);
    return errs;
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: not in enum`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path}: too long`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: too many items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (isObj) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errs.push(`${path}: too few properties`);
    for (const r of schema.required ?? []) if (!Object.hasOwn(value, r)) errs.push(`${path}: missing ${r}`);
    for (const k of keys) {
      if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern).test(k)) errs.push(`${path}: key ${JSON.stringify(k)} breaks propertyNames`);
      if (schema.properties && Object.hasOwn(schema.properties, k)) errs.push(...validate(schema.properties[k], value[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: extra property ${JSON.stringify(k)}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties, value[k], `${path}.${k}`));
    }
  }
  return errs;
}
