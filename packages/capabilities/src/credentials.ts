export interface CredentialProvider {
  get(name: string): Promise<string | undefined>;
}

export class EmptyCredentialProvider implements CredentialProvider {
  async get(_name: string): Promise<undefined> {
    return undefined;
  }
}

export class AllowlistedEnvironmentCredentialProvider implements CredentialProvider {
  constructor(
    private readonly allowedNames: string[],
    private readonly environment: Record<string, string | undefined> = process.env,
  ) {}

  async get(name: string): Promise<string | undefined> {
    if (!this.allowedNames.includes(name)) return undefined;
    return this.environment[name];
  }
}
