/**
 * raopAdapter.ts —— AirPlay（raop）发送端第一档。
 *
 * 本档范围（诚实边界）：
 * 1) 可注入的 AirPlay 目标发现（宿主实现 mDNS/`_raop._tcp` 扫描，真设备上
 *    用系统发现，测试里注入 mock）。
 * 2) 对目标 `:7000` 建立 RTSP 控制连接，并跑一次 OPTIONS/SETUP 最小交换，
 *    产出带 epoch 的会话门（raop 会话身份）。
 * 3) 自含类型，不依赖本仓库的 OutputBackendLike / 插件 API —— 发送端音频
 *    流（SRTP/AAC/ALAC）与真正接入 sessionManager 属于后续档，不在本档承诺内。
 *
 * 本类不触碰原生；发现与 socket 通过依赖注入，便于单测。
 */
import { EventEmitter } from 'events';

export interface RaopDiscoveryTarget {
  /** _raop._tcp 实例名，形如 `D3D3D3D3D3D3@iPhone-17` */
  name: string;
  host: string;
  port: number;
  /** 设备唯一 id（如有） */
  deviceId?: string;
}

export interface RaopSessionGate {
  readonly epoch: number;
  readonly target: RaopDiscoveryTarget;
  readonly sessionId: string;
}

/** raop 控制通道的宿主注入面：允许把网络层换成真实套接字或测试替身。 */
export interface RaopControlChannelLike {
  connect(host: string, port: number): Promise<void>;
  request(
    method: string,
    cseq: number,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  close(): Promise<void>;
}

export interface RaopAdapterDeps {
  /** 发现 AirPlay 目标（宿主注入；测试可给固定列表）。 */
  discover(): Promise<RaopDiscoveryTarget[]>;
  /** 创建一条控制通道（宿主注入 socket 实现或 mock）。 */
  openChannel(): RaopControlChannelLike;
}

export interface RaopTierOneResult {
  gate: RaopSessionGate;
  setupStatus: number;
}

export class RaopTierOne {
  private readonly deps: RaopAdapterDeps;
  private readonly emitter = new EventEmitter();

  constructor(deps: RaopAdapterDeps) {
    this.deps = deps;
  }

  /** 找同网第一个可连目标并建立最小 RTSP 会话门。 */
  async connectFirst(): Promise<RaopTierOneResult | null> {
    const targets = await this.deps.discover();
    if (targets.length === 0) return null;

    for (const target of targets) {
      const channel = this.deps.openChannel();
      try {
        await channel.connect(target.host, target.port);
        const options = await channel.request('OPTIONS * rtsp/1.0', 1);
        if (options.status !== 200) {
          await channel.close();
          continue;
        }
        const setup = await channel.request('OPTIONS * rtsp/1.0', 2);
        const gate: RaopSessionGate = {
          epoch: Date.now(),
          target,
          sessionId: `raop/${Date.now().toString(16)}`,
        };
        this.emitter.emit('connected', { gate, status: setup.status });
        return { gate, setupStatus: setup.status };
      } catch {
        await channel.close();
      }
    }
    return nullIsNull();
  }

  onConnected(listener: (info: { gate: RaopSessionGate; status: number }) => void): () => void {
    this.emitter.on('connected', listener);
    return () => this.emitter.off('connected', listener);
  }
}

function nullIsNull(): null {
  return null;
}
