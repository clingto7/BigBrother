const DEFAULT_API_BASE_URL = "https://api.github.com";

export class GitHubRestAdapter {
  #fetch;
  #token;
  #baseUrl;
  #pageSize;

  constructor({ token, fetchImpl = fetch, apiBaseUrl = DEFAULT_API_BASE_URL, pageSize = 100 }) {
    this.#fetch = fetchImpl;
    this.#token = token;
    this.#baseUrl = apiBaseUrl.replace(/\/$/, "");
    this.#pageSize = pageSize;
  }

  async getBranchHead({ repositoryId, branchName }) {
    const body = await this.#get(
      `/repos/${repositoryId}/git/ref/heads/${encodeURIComponent(branchName)}`,
    );
    const sha = body?.object?.sha;
    if (typeof sha !== "string" || sha.length === 0) {
      throw new Error(`GitHub branch response has no commit SHA: ${repositoryId}:${branchName}`);
    }
    return { sha };
  }

  async listCommits({ repositoryId, fromSha, toSha }) {
    const commits = [];
    for (let page = 1; ; page += 1) {
      const body = await this.#get(
        `/repos/${repositoryId}/compare/${encodeURIComponent(fromSha)}...${encodeURIComponent(toSha)}?per_page=${this.#pageSize}&page=${page}`,
      );
      if (!Array.isArray(body?.commits)) {
        throw new Error(`GitHub compare response has no commits array: ${repositoryId}`);
      }
      commits.push(...body.commits);
      if (body.commits.length < this.#pageSize) return commits;
    }
  }

  async createCheckRun({ repositoryId, name, headSha, conclusion, output }) {
    return this.#request(`/repos/${repositoryId}/check-runs`, {
      method: "POST",
      body: { name, head_sha: headSha, status: "completed", conclusion, output },
    });
  }

  async updateCheckRun({ repositoryId, checkRunId, conclusion, output }) {
    return this.#request(`/repos/${repositoryId}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: { status: "completed", conclusion, output },
    });
  }

  async createCommitStatus({ repositoryId, commitSha, state, context, description, targetUrl }) {
    return this.#request(`/repos/${repositoryId}/statuses/${commitSha}`, {
      method: "POST",
      body: {
        state,
        context,
        ...(description ? { description } : {}),
        ...(targetUrl ? { target_url: targetUrl } : {}),
      },
    });
  }

  async #get(path) {
    return this.#request(path, { method: "GET" });
  }

  async #request(path, { method, body }) {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      let message = "unknown error";
      try {
        message = (await response.json())?.message ?? message;
      } catch {
        // Preserve the HTTP failure even when the response is not JSON.
      }
      throw new Error(`GitHub API request failed (${response.status}): ${message}`);
    }
    return response.json();
  }
}
