import type { AuditService } from '../service';

/**
 * Everything the agent runtime may ask of the service (spec §5.4). Signing, recording test results and editing
 * findings, scope or test plans by hand are deliberately absent: the runtime is given this object, never the service.
 */
export interface AgentPort {
  engagement: AuditService['engagement'];
  runModule: AuditService['runModuleAsAgent'];
  saveTestPlans: AuditService['saveTestPlansAsAgent'];
  agentBundle: AuditService['agentBundle'];
}

export const AGENT_PORT_METHODS = ['agentBundle', 'engagement', 'runModule', 'saveTestPlans'] as const;

export function agentPort(svc: AuditService): AgentPort {
  const port: AgentPort = {
    engagement: (id) => svc.engagement(id),
    runModule: (...args) => svc.runModuleAsAgent(...args),
    saveTestPlans: (...args) => svc.saveTestPlansAsAgent(...args),
    agentBundle: (...args) => svc.agentBundle(...args),
  };
  return Object.freeze(port);
}
