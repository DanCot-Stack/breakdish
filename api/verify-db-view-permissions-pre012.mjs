console.log(JSON.stringify({
  success: false,
  failureStage: "obsolete-checkpoint",
  safeNextStep: "Use verify-db-view-permissions-pre013.mjs for the current release baseline."
}));
process.exitCode = 2;
