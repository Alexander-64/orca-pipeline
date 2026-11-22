import { defaultRunner, type CommandRunner } from './cli'

export type PrStatus = { url: string; headRefOid: string; checks: { name: string; state: string }[] }

export interface PrClient {
  create(workspacePath: string, base: string): Promise<PrStatus>
  checks(url: string): Promise<PrStatus>
  merge(url: string, expectedHead: string): Promise<void>
}

export class GhPrClient implements PrClient {
  constructor(private readonly runner: CommandRunner = defaultRunner, private readonly executable = 'gh') {}

  private async call(args: string[], workspacePath?: string): Promise<unknown> {
    const result = await this.runner(this.executable, args, workspacePath, 60_000)
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `gh exited ${result.code}`)
    return result.stdout.trim()
  }

  private async json(args: string[], workspacePath?: string): Promise<unknown> {
    const output = await this.call(args, workspacePath)
    return JSON.parse(String(output))
  }

  async create(workspacePath: string, base: string): Promise<PrStatus> {
    let url: string
    try {
      url = String(await this.call(['pr', 'create', '--base', base, '--fill'], workspacePath))
    } catch (error) {
      if (!String(error).includes('already exists')) throw error
      const current = await this.json(['pr', 'view', '--json', 'url,headRefOid'], workspacePath) as Record<string, unknown>
      url = String(current.url)
    }
    return this.checks(url)
  }

  async checks(url: string): Promise<PrStatus> {
    const current = await this.json(['pr', 'view', url, '--json', 'url,headRefOid']) as Record<string, unknown>
    const checks = await this.json(['pr', 'checks', url, '--json', 'name,state,bucket']) as Record<string, unknown>[]
    return {
      url,
      headRefOid: String(current.headRefOid),
      checks: checks.map((check) => ({ name: String(check.name), state: String(check.bucket ?? check.state) }))
    }
  }

  async merge(url: string, expectedHead: string): Promise<void> {
    const current = await this.checks(url)
    if (current.headRefOid !== expectedHead) throw new Error('The PR head changed. Merge stopped')
    await this.call(['pr', 'merge', url, '--merge'])
  }
}
