function workflowState(plan) {
  if (plan.state === "closed") return "closed";
  return plan.checklistDone > 0 || (plan.agentSessions?.length || 0) > 0
    ? "active"
    : "pending";
}

module.exports = { workflowState };
