/**
 * rev6 R2-1 / R2-2: probe the REAL plugin apply context (RC3 evidence).
 *
 * WHY THIS MODULE EXISTS (and how it differs from rc2)
 * ---------------------------------------------------
 * rev5's rc2 classified the eight surfaces from an adapter the SMOKE built on a
 * freshly constructed, BARE Cordis Context. That context carries none of the
 * DSH services (`ctx.systemPrompt` / `ctx.tools` / `ctx.agents`), so the
 * production resolver fell through to the in-memory reference while the smoke's
 * own adapter was the hook one - a discrepancy rc2 had to DISCLAIM in prose
 * (`resolveNote`). A disclaimer is not evidence.
 *
 * rc3 removes the discrepancy instead of explaining it: it calls the plugin's
 * OWN `apply()` on a context that has the real host services mounted, then reads
 *   (a) the hooks `apply()` actually registered on the real `ctx.on`,
 *   (b) the identity each real dispatch really carries (via the plugin's own
 *       `readHookScope`), and
 *   (c) the handle's own `surfaces` projection - production code, not report
 *       code - and cross-checks it against the classified matrix.
 *
 * WHAT THIS MODULE REFUSES TO DO
 * -----------------------------
 *   - It never upgrades an unobserved face to `native`. `lastMountResult` is
 *     omitted unless a mount was actually ATTEMPTED, matching the adapter's
 *     collect-or-omit rule; `apply()` registers hooks but mounts no surface, so
 *     a status reader that reports `lastMountResult` here would be inventing a
 *     measurement.
 *   - It never invents a `branchId`. If the host supplies none (it does not, on
 *     DSH 0.2.1-rc.5), the identity rows say so and R2-2 is reported blocked.
 *   - It performs no writes and no real tool/model/memory calls. The dispatches
 *     it makes are the four hook waterfalls the host itself would make, each with
 *     an identity-free payload so the plugin's D1 fail-closed path passes it
 *     through.
 *
 * Everything here is exported; the in-host runner owns rendering and timing.
 */

/** The four hook waterfalls the DSH 0.2.1-rc.5 host dispatches. */
const DISPATCH_PLAN = Object.freeze([
  {
    event: 'system-prompt/assemble',
    makePayload: () => ({ sections: [{ name: 'rc3-base', text: 'rc3 apply-context probe' }] }),
    makeNext: () => ({ sections: [{ name: 'rc3-base', text: 'rc3 apply-context probe' }] })
  },
  {
    event: 'tools/pre-execute',
    makePayload: () => ({ name: 'rc3-apply-context-probe', arguments: {} }),
    makeNext: () => ({ kind: 'allow' })
  },
  {
    event: 'tools/post-execute',
    makePayload: () => ({ name: 'rc3-apply-context-probe', result: { ok: true } }),
    makeNext: () => ({ ok: true })
  },
  {
    event: 'agent/pre-step',
    makePayload: () => ({}),
    makeNext: () => ({ kind: 'enter' })
  }
]);

/**
 * Probe the real apply context.
 *
 * @param {object} input
 * @param {object} input.host   real host modules: `{ createContext, SystemPrompt, ToolRuntime }`
 * @param {object} input.plugin production symbols (apply, classifySurfaceMatrix, ...)
 * @param {object} [input.config] parsed config for `apply()` / the matrix
 * @param {string[]} [input.expectedHookEvents] hook names the adapter claims to support
 * @returns {Promise<object>} the probe result (see the shape below)
 */
export async function probeApplyContext(input) {
  const { host, plugin } = input;
  const problems = [];
  const result = {
    ok: false,
    applyContext: {
      contextKind: 'bare-cordis-context',
      services: { tools: false, systemPrompt: false, commands: false },
      productionResolvedSource: 'not-run',
      detectDetected: false,
      structuralSeams: 0,
      applyReturnedHandle: false,
      applyError: null
    },
    hookRegistration: { registered: [], expected: [], missing: [], extra: [], matched: false },
    identity: [],
    surfaces: [],
    /** The adapter source the classifier was told about (never production's answer). */
    classifiedAdapterSource: null,
    matrix: null,
    crossCheck: {
      checked: 0,
      disagreements: [],
      lastMountResultObserved: 0,
      cacheReadUnknown: 0,
      note: ''
    },
    dispose: { disposed: false, error: null },
    problems
  };

  // --- 0. a context with the REAL host services ---------------------------
  const ctx = host.createContext();
  ctx.plugin(host.SystemPrompt);
  ctx.plugin(host.ToolRuntime);
  // Cordis activates plugins on the microtask queue.
  await new Promise((resolve) => setTimeout(resolve, 250));

  result.applyContext.services = {
    tools: ctx.tools !== undefined,
    systemPrompt: ctx.systemPrompt !== undefined,
    commands: ctx.commands !== undefined
  };
  if (!result.applyContext.services.tools || !result.applyContext.services.systemPrompt) {
    problems.push('the apply context did not activate ctx.tools/ctx.systemPrompt; rc3 evidence is not-run');
    return result;
  }

  // --- 1. production adapter resolution ON THIS SAME CONTEXT --------------
  // This is the fact rc2 could not state: on a context with real services the
  // production resolver agrees with the hook adapter.
  const resolutionDiagnostics = [];
  const resolution = plugin.resolveHostAdapter(ctx, {}, resolutionDiagnostics);
  result.applyContext.productionResolvedSource = resolution.hostAdapterSource;
  result.applyContext.structuralSeams = plugin.hostAdapterSeamCount(plugin.createCordisHostFromContext(ctx));
  result.applyContext.detectDetected = plugin.detectDshHookHost(ctx).detected;

  // --- 2. instrument `ctx.on` BEFORE apply() so registrations are counted --
  const registeredHooks = [];
  const originalOn = ctx.on.bind(ctx);
  ctx.on = function instrumentedOn(event, listener, ...rest) {
    registeredHooks.push(String(event));
    return originalOn(event, listener, ...rest);
  };
  const originalWaterfall = ctx.waterfall.bind(ctx);

  // --- 3. the plugin's OWN apply() ---------------------------------------
  let handle;
  try {
    handle = plugin.apply(ctx, input.config === undefined ? {} : { config: input.config });
    result.applyContext.applyReturnedHandle = handle !== null && typeof handle === 'object';
  } catch (error) {
    result.applyContext.applyError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    problems.push('apply() threw: ' + result.applyContext.applyError);
  }
  // Let registrations settle (the plugin registers hook listeners synchronously,
  // but command registration and the orchestrator wiring are async).
  await new Promise((resolve) => setTimeout(resolve, 250));

  // --- 4. which hooks did apply() really register? -----------------------
  const expectedHookEvents = input.expectedHookEvents ?? [];
  const registeredSet = [...new Set(registeredHooks)].sort();
  const expectedSet = [...new Set(expectedHookEvents)].sort();
  result.hookRegistration = {
    registered: registeredSet,
    expected: expectedSet,
    missing: expectedSet.filter((event) => !registeredSet.includes(event)),
    // Hooks present beyond the contract are informative, never a failure: the
    // plugin legitimately also listens to session/agent lifecycle events.
    extra: registeredSet.filter((event) => !expectedSet.includes(event)),
    matched: expectedSet.length > 0 && expectedSet.every((event) => registeredSet.includes(event))
  };
  if (expectedSet.length === 0) {
    problems.push('no expected hook events were supplied; hook registration cannot be judged');
  } else if (!result.hookRegistration.matched) {
    problems.push('apply() did not register every expected hook: missing ' + result.hookRegistration.missing.join(', '));
  }

  // --- 5. real dispatches: what identity does the host actually supply? ---
  // Observed through the plugin's OWN reader, on the plugin's own listeners.
  const captured = new Map();
  for (const plan of DISPATCH_PLAN) {
    // An observer listener registered AFTER apply() sees the same args the
    // plugin's listener sees, including any agent/session carrier.
    try {
      originalOn(plan.event, async (...args) => {
        const next = args[args.length - 1];
        const identity = plugin.readHookScope(...args.slice(0, -1));
        captured.set(plan.event, {
          event: plan.event,
          dispatched: true,
          branchIds: identity.branchIds.size,
          sessionIds: identity.sessionIds.size,
          namespaces: identity.namespaces.size,
          fields: Object.keys(args[0] && typeof args[0] === 'object' ? args[0] : {}),
          matched: plugin.hookScopeMatches(identity, {
            branchId: 'rc3-probe-branch',
            sessionId: 'rc3-probe-session',
            namespace: 'rc3-probe-ns',
            scopeClass: 'branch'
          })
        });
        return typeof next === 'function' ? next() : { kind: 'allow' };
      });
    } catch (error) {
      problems.push(plan.event + ': observer listener could not be installed (' + String(error?.message ?? error) + ')');
    }
  }

  for (const plan of DISPATCH_PLAN) {
    try {
      await originalWaterfall(ctx, plan.event, plan.makePayload(), () => Promise.resolve(plan.makeNext()));
    } catch (error) {
      problems.push(plan.event + ': dispatch threw (' + String(error?.message ?? error) + ')');
    }
    if (!captured.has(plan.event)) {
      captured.set(plan.event, {
        event: plan.event,
        dispatched: false,
        branchIds: 0,
        sessionIds: 0,
        namespaces: 0,
        fields: [],
        matched: false
      });
    }
  }
  result.identity = [...captured.values()].sort((left, right) => left.event.localeCompare(right.event));

  // --- 6. the handle's OWN surface projection (production code) ----------
  if (handle !== undefined && Array.isArray(handle.surfaces)) {
    result.surfaces = handle.surfaces.map((entry) => ({
      surface: entry.surface,
      enabled: entry.enabled === true,
      mountable: entry.mountable === true,
      hasLastMountResult: 'lastMountResult' in entry,
      lastMountResult: entry.lastMountResult ?? null,
      hasSeamUnavailable: 'seamUnavailable' in entry,
      seamUnavailable: entry.seamUnavailable ?? null,
      cacheRead: entry.cacheRead ?? null
    }));
  } else {
    problems.push('the handle exposed no surfaces projection; the surface cross-check is not-run');
  }

  // --- 7. classify the eight faces from an adapter over THIS context -----
  // The adapter is built over the SAME context the plugin just mounted on.
  //
  // IMPORTANT: the matrix is labelled with the source of the adapter we ACTUALLY
  // built, NOT with production's answer. Labelling it `productionResolvedSource`
  // would make the agreement check below tautological - it could never fail, and
  // a check that cannot fail is not evidence (that was rc2's real problem, just
  // moved one step). rc2's defect was reaching for the label; rc3 derives both
  // sides independently and lets them disagree.
  const CLASSIFIED_ADAPTER_SOURCE = 'dsh-hooks'; // == the builder used just below
  let matrixAdapter;
  try {
    matrixAdapter = plugin.createDshHookHostAdapter(ctx, {
      onDiagnostic: (message) => problems.push('adapter diagnostic: ' + message)
    });
    const hookEvidence = result.identity.map((entry) => ({
      event: entry.event,
      dispatched: entry.dispatched,
      payloadFields: entry.fields
    }));
    result.classifiedAdapterSource = CLASSIFIED_ADAPTER_SOURCE;
    result.matrix = plugin.classifySurfaceMatrix({
      capturedAt: new Date().toISOString(),
      adapter: matrixAdapter,
      hostAdapterSource: CLASSIFIED_ADAPTER_SOURCE,
      hookDetected: result.applyContext.detectDetected,
      installedHookEvents: result.hookRegistration.registered,
      hookEvidence,
      structuralSeams: result.applyContext.structuralSeams,
      enabledSurfaces: (handle?.config?.enabledSurfaces) ?? [],
      resolveHostAdapterSource: result.applyContext.productionResolvedSource,
      contextKind: 'bare-cordis-context'
    });
    const matrixProblems = plugin.validateSurfaceMatrix(result.matrix);
    for (const matrixProblem of matrixProblems) {
      problems.push('surface matrix: ' + matrixProblem);
    }
  } catch (error) {
    problems.push('surface classification threw: ' + String(error?.message ?? error));
  }

  // --- 8. cross-check: matrix (classification) vs handle (production) ----
  // Two independent production paths must agree. A `native` face whose handle
  // says `mountable=false` is a contradiction, and a face the handle marks
  // mountable must not be classified `unavailable`.
  if (result.matrix !== null && result.surfaces.length > 0) {
    const bySurface = new Map(result.surfaces.map((entry) => [entry.surface, entry]));
    for (const face of result.matrix.faces) {
      const status = bySurface.get(face.surface);
      result.crossCheck.checked += 1;
      if (status === undefined) {
        result.crossCheck.disagreements.push(face.surface + ': classified but absent from the handle projection');
        continue;
      }
      if (face.availability === 'native' && status.mountable !== true) {
        result.crossCheck.disagreements.push(
          face.surface + ': matrix=native but handle.mountable=false'
        );
      }
      if (face.availability === 'unavailable' && status.mountable === true) {
        result.crossCheck.disagreements.push(
          face.surface + ': matrix=unavailable but handle.mountable=true'
        );
      }
      if (status.hasLastMountResult) {
        result.crossCheck.lastMountResultObserved += 1;
      }
      if (status.cacheRead === 'unknown') {
        result.crossCheck.cacheReadUnknown += 1;
      }
    }
  }
  result.crossCheck.note =
    'apply() registers hooks but mounts no surface, so lastMountResult is legitimately absent: ' +
    'the adapter only records a mount when a surface method is called (probe/patch paths), and no ' +
    'surface was mounted here. observed=' + String(result.crossCheck.lastMountResultObserved) + '/8';

  // --- 9. dispose: leave nothing behind ---------------------------------
  try {
    if (handle !== undefined && typeof handle.dispose === 'function') {
      await handle.dispose();
      result.dispose.disposed = true;
    }
  } catch (error) {
    result.dispose.error = String(error?.message ?? error);
    problems.push('handle.dispose() threw: ' + result.dispose.error);
  }

  result.ok = problems.length === 0;
  return result;
}

/**
 * The rc3 gate decisions, kept pure so both the in-host runner and the e2e
 * tests judge the SAME rules.
 *
 * @param {object} probe result of `probeApplyContext`
 * @returns {{applyContextEvidence: boolean, surfaceEvidence: boolean, blocked: boolean,
 *            applyReasons: string[], branchReasons: string[]}}
 */
export function judgeApplyContext(probe) {
  const applyReasons = [];
  const branchReasons = [];
  if (probe === undefined || probe === null) {
    return {
      applyContextEvidence: false,
      surfaceEvidence: false,
      blocked: true,
      applyReasons: ['probe did not run'],
      branchReasons: ['probe did not run']
    };
  }
  const applyContextEvidence =
    probe.applyContext.applyReturnedHandle === true &&
    probe.applyContext.services.tools === true &&
    probe.applyContext.services.systemPrompt === true &&
    probe.hookRegistration.matched === true;
  if (!applyContextEvidence) {
    applyReasons.push('the probe did not observe a real apply context with every expected hook');
  }

  // Production resolution and the adapter the classifier was GIVEN must agree;
  // otherwise the matrix describes an adapter the plugin would not use (rc2's
  // defect, stated as an equality instead of a disclaimer).
  const classifiedSource = probe.classifiedAdapterSource ?? (probe.matrix === null ? null : probe.matrix.hostAdapterSource);
  if (probe.matrix === null) {
    applyReasons.push('no surface matrix was produced');
  } else if (probe.applyContext.productionResolvedSource !== classifiedSource) {
    applyReasons.push(
      'production resolution (' + probe.applyContext.productionResolvedSource + ') disagrees with the classified adapter (' +
        String(classifiedSource) + ')'
    );
  }

  // The cross-check must have covered every face, and each disagreement is its
  // own reason (so the note names the contradicting surface).
  if (probe.matrix !== null && probe.crossCheck.checked !== 8) {
    applyReasons.push('the cross-check covered ' + probe.crossCheck.checked + '/8 faces');
  }
  for (const disagreement of probe.crossCheck.disagreements) {
    applyReasons.push('cross-check: ' + disagreement);
  }

  // Surface evidence requires: a matrix, 8/8 cross-checked faces, no
  // disagreements, AND no apply-level reason (which includes a production/
  // classified-source mismatch). Deriving it from `applyReasons` is deliberate:
  // a separate boolean is exactly how the disagreement check became
  // unfalsifiable once already.
  const surfaceEvidence = applyReasons.length === 0 && probe.matrix !== null && probe.crossCheck.checked === 8;

  // Branch identity is a SEPARATE obligation (R2-2): its absence must not be
  // reported as a failure of the surface evidence (R2-1), and vice versa. Each
  // reason list feeds only its own report row.
  const blocked = probe.identity.length > 0 && probe.identity.every((entry) => entry.branchIds === 0);
  if (blocked) {
    branchReasons.push('no hook dispatch carried a branchId; branch-aware isolation evidence is blocked');
  } else if (probe.identity.length === 0) {
    branchReasons.push('no dispatch was observed; identity cannot be judged');
  }

  return { applyContextEvidence, surfaceEvidence, blocked, applyReasons, branchReasons };
}
