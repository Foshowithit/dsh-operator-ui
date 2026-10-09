import z from '@deepseek-ai/schemastery';

/** Cordis plugin that intersects a preset's inherited host tools with an allowlist. */
export const name = 'tool-restriction';
export const inject = ['tools'];

export const Config = z.object({
  /** Global tools the preset may inherit; its own scoped tools remain visible. */
  allow: z.array(z.string()).required(),
});

export function apply(ctx, config) {
  if (new Set(config.allow).size !== config.allow.length) throw new Error('tool-restriction allow list must not contain duplicates');

  // Preset-local registrations live on the preset's standing scope and are
  // inherited by each agent. A registry `allow` mask on that scope would hide
  // those tools too, so mask only the host-global names outside this seat's
  // allowlist. Unscoped schemas are the RC.1 host-global view.
  // The unscoped PTC projection can append the reserved run_code transport;
  // it is presentation infrastructure and tools.restrict() explicitly rejects it.
  const globalNames = ctx.tools.schemas().map(({ name }) => name).filter((name) => name !== 'run_code');
  const globalNameSet = new Set(globalNames);
  const allow = new Set(config.allow);
  const missing = config.allow.filter((toolName) => !globalNameSet.has(toolName));
  if (missing.length > 0) {
    throw new Error(`tool-restriction allowlist names not a registered global tool: ${missing.join(', ')}`);
  }

  const deny = globalNames.filter((toolName) => !allow.has(toolName));
  if (deny.length > 0) ctx.tools.restrict({ deny });
}
