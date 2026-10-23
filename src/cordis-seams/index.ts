/**
 * Public surface of the Cordis eight-surface seam layer (module owner: t3).
 *
 * Downstream consumers (harness2 prober, dream-rsi, orchestrator) should import
 * from this barrel:
 *   - CordisSeamManager / createCordisSeamManager : ICordisSeamManager impl
 *   - CordisHostAdapter / createInMemoryCordisHost : host-neutral seam adapter
 *   - mountEightSurfaces / mountSurface : eight-surface mounting
 *   - TrajectoryCollector / computeTrajectoryMetrics : trajectory collection
 *   - DisposableRegistry : LIFO reversible-effect unwinding
 */
export * from './disposable-registry';
export * from './dsh-hook-host-adapter';
export * from './eight-surfaces';
export * from './errors';
export * from './context-forker';
export * from './host-adapter';
export * from './patch-utils';
export * from './seam-manager';
export * from './trajectory-collector';
