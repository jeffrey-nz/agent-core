export function enforceReviewerContract({
  reviewerVerdict,
  contract,
  artifactsProvided,
}) {
  if (
    contract.allowsScripts &&
    artifactsProvided.includes("script") &&
    reviewerVerdict === "FAIL"
  ) {
    return {
      override: true,
      reason: "Reviewer contract violated: scripts/utilities were acceptable.",
    };
  }

  return { override: false };
}
