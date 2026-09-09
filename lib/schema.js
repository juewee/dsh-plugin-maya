/**
 * Minimal tool-definition helper for dsh-plugin-maya.
 *
 * The plugin is deliberately dependency-free so it can be loaded straight from
 * a `file://` URL by the DSH loader (no pnpm install, no node_modules next to
 * the plugin). It therefore re-implements the small part of
 * `@deepseek-ai/dsh-tools`' `defineTool` that this plugin needs: raw JSON
 * Schema parameters/output plus model-argument validation.
 *
 * The produced object is exactly the shape the DSH tool registry expects:
 * `{ name, description, parameters, output: { schema, render }, execute, ... }`.
 */

/**
 * Validate one value against the supported JSON Schema subset.
 * @param {object} schema raw JSON Schema node.
 * @param {unknown} value candidate value.
 * @param {string} [path] path label used in violation messages.
 * @param {string[]} [violations] accumulator.
 * @returns {string[]} path-qualified violations; empty means valid.
 */
export function validateValue(schema, value, path = 'value', violations = []) {
  if (schema === null || typeof schema !== 'object') return violations;

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((branch) => validateValue(branch, value, path, []).length === 0);
    if (!matched) violations.push(path + ' does not match any allowed shape');
    return violations;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(path + ' must be one of ' + schema.enum.map((v) => JSON.stringify(v)).join(', '));
    return violations;
  }

  const type = schema.type;
  if (type === undefined) return violations;

  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(path + ' must be an object');
      return violations;
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) violations.push(path + '.' + key + ' is required');
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateValue(properties[key], item, path + '.' + key, violations);
      } else if (schema.additionalProperties === false) {
        violations.push(path + '.' + key + ' is not allowed');
      }
    }
    return violations;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(path + ' must be an array');
      return violations;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      violations.push(path + ' must contain at least ' + schema.minItems + ' item(s)');
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      violations.push(path + ' must contain at most ' + schema.maxItems + ' item(s)');
    }
    if (schema.items) {
      value.forEach((item, index) => validateValue(schema.items, item, path + '[' + index + ']', violations));
    }
    return violations;
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      violations.push(path + ' must be a string');
      return violations;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      violations.push(path + ' must be at least ' + schema.minLength + ' character(s)');
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      violations.push(path + ' must be at most ' + schema.maxLength + ' character(s)');
    }
    return violations;
  }

  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(path + ' must be an integer');
    return violations;
  }

  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(path + ' must be a finite number');
    return violations;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') violations.push(path + ' must be a boolean');
    return violations;
  }

  if (type === 'null') {
    if (value !== null) violations.push(path + ' must be null');
  }

  return violations;
}

/** Model-supplied arguments rejected by a typed tool. */
export class ToolArgsError extends Error {
  /** @param {string[]} violations path-qualified violations. */
  constructor(violations) {
    super('invalid arguments: ' + violations.join('; '));
    this.name = 'ToolArgsError';
    this.violations = violations;
  }
}

/**
 * Build a registry-ready tool definition from raw JSON Schema.
 * @param {object} options tool definition options.
 * @param {string} options.name model-facing tool name.
 * @param {string} options.description model-facing description.
 * @param {object} options.parameters raw JSON Schema for the implicit parameter object.
 * @param {{ schema: object, render: (args: any, value: any) => any[] }} options.output canonical output declaration.
 * @param {(args: any, exec: any) => Promise<unknown>} options.execute tool body.
 * @param {(args: any) => boolean} [options.isConcurrencySafe] parallel-safety classifier.
 * @param {number} [options.timeoutMs] cooperative timeout budget.
 * @returns {object} a definition accepted by `ctx.tools.register`.
 */
export function defineTool(options) {
  const { name, description, parameters, output, execute } = options;
  if (!name || typeof name !== 'string') throw new Error('defineTool: name is required');
  if (typeof description !== 'string' || description.length === 0) throw new Error('defineTool(' + name + '): description is required');
  if (!parameters || parameters.type !== 'object') throw new Error('defineTool(' + name + '): parameters must be a raw object JSON Schema');
  if (!output || typeof output.render !== 'function') throw new Error('defineTool(' + name + '): output.render is required');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('defineTool(' + name + '): timeoutMs must be a positive finite number');
  }

  const definition = {
    name,
    description,
    parameters,
    output: {
      schema: output.schema,
      render(args, value) {
        return output.render(args, value);
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args ?? {}, 'arguments');
      if (violations.length > 0) throw new ToolArgsError(violations);
      return execute(args ?? {}, exec);
    },
  };

  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs;
  if (typeof options.isConcurrencySafe === 'function') {
    const classify = options.isConcurrencySafe;
    definition.isConcurrencySafe = (args) => (validateValue(parameters, args ?? {}, 'arguments').length > 0 ? false : classify(args ?? {}));
  }
  return definition;
}

/** Shorthand for a text-only render projection. */
export function text(text) {
  return [{ type: 'text', text }];
}
