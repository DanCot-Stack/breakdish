console.log(JSON.stringify({
  success: false,
  failureStage: "obsolete-checkpoint",
  safeNextStep: "Use verify-db-view-permissions-post013.mjs after migration 013."
}));
process.exitCode = 2;
