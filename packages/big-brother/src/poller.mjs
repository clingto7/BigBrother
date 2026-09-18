export async function pollRepository({ repositoryId, trackedBranches, github, store }) {
  let discovered = 0;

  for (const branchName of trackedBranches) {
    const branch = store.getBranch({ repositoryId, branchName });
    if (!branch) throw new Error(`branch is not enrolled: ${repositoryId}:${branchName}`);

    const head = await github.getBranchHead({ repositoryId, branchName });
    if (head.sha === branch.cursorSha) continue;

    const commits = await github.listCommits({
      repositoryId,
      branchName,
      fromSha: branch.cursorSha,
      toSha: head.sha,
    });
    if (commits.length === 0 || commits.at(-1)?.sha !== head.sha) {
      throw new Error(`GitHub commit range did not reach branch head: ${repositoryId}:${branchName}`);
    }

    for (const commit of commits) {
      if (store.admitCommitReview({ repositoryId, commitSha: commit.sha, branchName }).created) {
        discovered += 1;
      }
    }
    store.advanceBranch({ repositoryId, branchName, headSha: head.sha });
  }

  return { branches: trackedBranches.length, discovered };
}
