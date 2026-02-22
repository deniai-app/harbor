import { createAppAuth } from "@octokit/auth-app";

export class GitHubInstallationAuth {
  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
  ) {}

  async getInstallationToken(installationId: number): Promise<string> {
    const auth = createAppAuth({
      appId: this.appId,
      privateKey: this.privateKey,
      installationId,
    });

    const result = await auth({
      type: "installation",
      installationId,
    });

    return result.token;
  }
}
