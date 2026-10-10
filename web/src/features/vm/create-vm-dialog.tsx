import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { importErrorMessage } from '@/lib/import-errors'
import { vmIdOf } from '@/lib/vm-name'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PlatformChip } from '@/components/platform-chip'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CreateExitField, useCreateExit } from '@/features/vm/create-exit-field'
import {
  KERNELS,
  VM_CONCURRENCY_OPTIONS,
  VM_CREATE_AFTER,
  VM_LOCALES,
  VM_REGION_AUTO,
  VM_REGIONS,
  VM_TEMPLATES,
  VM_WEIGHT_OPTIONS,
} from '@/features/vm/create-options'
import { KernelFeatTags } from '@/features/vm/kernel-feat-tags'
import { preflightChecksFromError } from '@/features/vm/placement'
import {
  PlacementField,
  PreflightCheckList,
  usePlacement,
} from '@/features/vm/placement-field'
import {
  type KvmCapability,
  kvmCapabilityQueryOptions,
  vmsListQueryOptions,
} from '@/features/vm/queries'

/** 「之后」的 5 档，对齐 index.html `createVmFromPage()` 的派生逻辑。 */
export type CreateVmAfter = 'idle' | 'start' | 'proxy' | 'active' | 'full'

const DEFAULT_TEMPLATE = VM_TEMPLATES[0]

type CreateVmResponse = {
  id?: string
  vm_id?: string
  vm?: { id?: string }
  start_error?: string
  /** 指定出口在创建瞬间没绑上（被别处占满等）。 */
  proxy_error?: string
}

/**
 * 「之后」→ 三个布尔的派生。index.html `createVmFromPage()`:
 *   start = after !== 'idle'
 *   auto_allocate_proxy = after === 'proxy' || after === 'full'
 *   activate = after === 'active' || after === 'full'
 */
function deriveAfter(after: string) {
  return {
    start: after !== 'idle',
    auto_allocate_proxy: after === 'proxy' || after === 'full',
    activate: after === 'active' || after === 'full',
  }
}

export type CreateVmFieldsProps = {
  /**
   * 「之后」的固定档位。传入时该档位被钉住（切模板不会覆盖），对齐 index.html
   * `applyVmTemplate()` 里 `state.view === 'import'` 的分支语义。不传则跟随模板预设。
   */
  defaultAfter?: CreateVmAfter
  /** 创建成功后回调，参数是实际创建到的槽位 id。 */
  onCreated?: (id: string) => void
  /** 传入则在提交按钮左侧渲染一个「取消」按钮（弹窗形态用）。 */
  onCancel?: () => void
  submitLabel?: string
}

/**
 * 创建槽位的字段集 + 提交逻辑。不含弹窗外壳 —— 导入向导 / 槽位页共用。
 * 创建不再提交 seed_policy 或槽内 SOCKS5；出口由外层透明转发，种子用网关 standard 默认。
 */
export function CreateVmFields({
  defaultAfter,
  onCreated,
  onCancel,
  submitLabel = '创建',
}: CreateVmFieldsProps) {
  const qc = useQueryClient()
  const [template, setTemplate] = useState<string>(DEFAULT_TEMPLATE.id)
  const [name, setName] = useState('')
  const [kernel, setKernel] = useState<string>(DEFAULT_TEMPLATE.kernel)
  const [after, setAfter] = useState<string>(
    defaultAfter || DEFAULT_TEMPLATE.after
  )
  const [region, setRegion] = useState<string>(
    DEFAULT_TEMPLATE.region || VM_REGION_AUTO
  )
  const [locale, setLocale] = useState<string>(DEFAULT_TEMPLATE.locale)
  const [conc, setConc] = useState<number>(DEFAULT_TEMPLATE.conc)
  const [openaiOwnConc, setOpenaiOwnConc] = useState(false)
  const [openaiConc, setOpenaiConc] = useState<number | null>(null)
  const [weight, setWeight] = useState<number>(DEFAULT_TEMPLATE.weight)
  const [platform, setPlatform] = useState<'anthropic' | 'openai'>('anthropic')
  const [runtime, setRuntime] = useState<'docker' | 'kvm'>('docker')
  const [advOpen, setAdvOpen] = useState(false)

  // 名称留空时由后端编号：它还会跳过已删除槽位留下历史用量的序号，前端推不出来。
  const typedName = name.trim()
  const placement = usePlacement(kernel)
  const remoteGpt = !!placement.nodeId && platform === 'openai'
  const exit = useCreateExit(placement.nodeId)
  const wantsExit = after !== 'idle'
  // GPT 槽不走 Claude 内核，KVM 只对 Claude 槽有意义。
  const kvmAllowed = platform === 'anthropic'
  const wantsKvm = kvmAllowed && runtime === 'kvm'
  const kvm = useQuery(
    kvmCapabilityQueryOptions(kernel, placement.nodeId, wantsKvm)
  )
  const kvmBlocked = wantsKvm && (kvm.isFetching || kvm.data?.ok !== true)

  /** 切模板：回填内核/区域/语言/并发/权重与「之后」。时区不在这里选。 */
  function applyTemplate(id: string) {
    const tpl = VM_TEMPLATES.find((x) => x.id === id) || DEFAULT_TEMPLATE
    setTemplate(tpl.id)
    setKernel(tpl.kernel)
    // 宿主钉死了「之后」（导入向导）时不跟模板走，其余场景用模板预设。
    setAfter(defaultAfter || tpl.after)
    setRegion(tpl.region || VM_REGION_AUTO)
    setLocale(tpl.locale)
    setConc(tpl.conc)
    setOpenaiConc(null)
    setOpenaiOwnConc(false)
    setWeight(tpl.weight)
  }

  const create = useMutation({
    mutationFn: async () => {
      // 自由文本名称：纯非 ASCII（如「测试槽」）会被清洗成空串 —— 那就不发 id，让后端自动编号。
      const id = typedName ? vmIdOf(typedName) || undefined : undefined
      const nodeId = placement.nodeId
      const data = await api<CreateVmResponse>('/api/panel/vms/create', {
        method: 'POST',
        body: JSON.stringify({
          id,
          ...(typedName ? { name: typedName } : {}),
          kernel,
          locale,
          // 「自动」是纯 UI 哨兵值，不发给后端（对齐 index.html 的 `region || undefined`）。
          region: region === VM_REGION_AUTO ? undefined : region,
          ...(platform === 'openai'
            ? openaiOwnConc && openaiConc != null
              ? { max_concurrency: openaiConc }
              : {}
            : { max_concurrency: conc }),
          weight,
          ...deriveAfter(after),
          platform,
          family: platform === 'openai' ? 'codex' : 'claude',
          ...(nodeId ? { node_id: nodeId } : {}),
          ...(wantsExit && exit.proxyId ? { proxy_id: exit.proxyId } : {}),
          ...(wantsKvm ? { runtime_type: 'kvm' } : {}),
        }),
      })
      return {
        id: data.id || data.vm_id || data.vm?.id || id || '',
        startError: data.start_error || '',
        proxyError: data.proxy_error || '',
      }
    },
    onSuccess: async (created) => {
      if (created.proxyError) {
        toast.warning(`出口未绑定：${created.proxyError}`)
      }
      if (created.startError) {
        toast.warning(
          created.id
            ? `已创建 ${created.id}，开机失败：${created.startError}`
            : `已创建，开机失败：${created.startError}`
        )
      } else {
        toast.success(created.id ? `已创建 ${created.id}` : '已创建')
      }
      setName('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      ])
      // 拿不到 id 时不回调：导入向导会把它当成 `setVmId('')`，反而把已选中的槽清掉。
      if (created.id) onCreated?.(created.id)
    },
    onError: (error: Error) => {
      toast.error(importErrorMessage(error))
      // 预检在提交前后可能变了（节点掉线 / 镜像被删），刷新一次让上方检查项同步。
      if (isApiError(error) && error.code === 'placement_preflight_failed') {
        void placement.preflight.refetch()
      }
    },
  })
  const placementChecks = preflightChecksFromError(create.error)

  return (
    <div className='space-y-3'>
      <div className='space-y-1'>
        <Label>模板</Label>
        <Select value={template} onValueChange={applyTemplate}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VM_TEMPLATES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='space-y-1'>
        <Label>平台</Label>
        <Select
          value={platform}
          onValueChange={(next) => {
            if (next === 'anthropic' || next === 'openai') {
              setPlatform(next)
              if (next === 'openai') {
                setOpenaiConc(null)
                setOpenaiOwnConc(false)
              }
            }
          }}
        >
          <SelectTrigger aria-label='槽位平台'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='anthropic'>
              <span className='inline-flex items-center gap-1.5'>
                <PlatformChip kind='claude' />
                默认
              </span>
            </SelectItem>
            <SelectItem value='openai'>
              <PlatformChip kind='codex' />
            </SelectItem>
          </SelectContent>
        </Select>
        {platform === 'openai' ? (
          <p className='text-xs text-muted-foreground'>
            可先创建空槽，账号用 OAuth 或 auth.json 稍后导入。
          </p>
        ) : null}
      </div>

      <div className='space-y-1'>
        <Label>名称</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='留空自动编号'
        />
      </div>

      <div className='space-y-1'>
        <Label>内核</Label>
        <Select value={kernel} onValueChange={setKernel}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KERNELS.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.name} · {k.size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <KernelFeatTags kernel={kernel} className='flex flex-wrap gap-1 pt-1' />
      </div>

      <PlacementField
        placement={placement}
        kernel={kernel}
        gptBlocked={remoteGpt}
      />

      {kvmAllowed ? (
        <div className='space-y-1'>
          <Label>隔离</Label>
          <Select
            value={runtime}
            onValueChange={(v) => {
              if (v === 'docker' || v === 'kvm') setRuntime(v)
            }}
          >
            <SelectTrigger aria-label='槽位隔离方式'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='docker'>容器（默认）</SelectItem>
              <SelectItem value='kvm'>KVM 虚拟机</SelectItem>
            </SelectContent>
          </Select>
          {wantsKvm ? <KvmCapabilityNote query={kvm} /> : null}
        </div>
      ) : null}

      <div className='space-y-1'>
        <Label>之后</Label>
        <Select value={after} onValueChange={setAfter}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VM_CREATE_AFTER.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {wantsExit ? (
        <CreateExitField exit={exit} remote={!!placement.nodeId} />
      ) : null}

      <Collapsible open={advOpen} onOpenChange={setAdvOpen}>
        <CollapsibleTrigger className='text-sm text-primary hover:underline'>
          高级 {advOpen ? '▴' : '▾'}
        </CollapsibleTrigger>
        <CollapsibleContent className='grid gap-3 pt-3 sm:grid-cols-2'>
          <div className='space-y-1'>
            <Label>区域</Label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_REGIONS.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1 sm:col-span-2'>
            <Label>时区</Label>
            <p className='text-sm'>时区未配置</p>
            <p className='text-xs text-muted-foreground'>
              绑定正在使用的 SOCKS5
              并完成地理探测后写入。探测没有时区，或结果不可用，就保持未配置。
            </p>
          </div>
          <div className='space-y-1'>
            <Label>语言</Label>
            <Select value={locale} onValueChange={setLocale}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_LOCALES.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {platform === 'openai' ? (
            <div className='space-y-2'>
              <Label>OpenAI 并发</Label>
              <div className='flex items-center gap-2'>
                <Switch
                  checked={openaiOwnConc}
                  onCheckedChange={(checked) => {
                    setOpenaiOwnConc(checked)
                    if (!checked) setOpenaiConc(null)
                    else setOpenaiConc(conc)
                  }}
                  aria-label='使用独立 OpenAI 并发'
                />
                {openaiOwnConc ? (
                  <Select
                    value={String(openaiConc ?? conc)}
                    onValueChange={(v) => setOpenaiConc(Number(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VM_CONCURRENCY_OPTIONS.filter((v) => v > 0).map((v) => (
                        <SelectItem key={v} value={String(v)}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className='text-xs text-muted-foreground'>
                    跟随已保存的 OpenAI 全局默认
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className='space-y-1'>
              <Label>并发</Label>
              <Select
                value={String(conc)}
                onValueChange={(v) => setConc(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VM_CONCURRENCY_OPTIONS.map((v) => (
                    <SelectItem key={v} value={String(v)}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className='space-y-1'>
            <Label>权重</Label>
            <Select
              value={String(weight)}
              onValueChange={(v) => setWeight(Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_WEIGHT_OPTIONS.map((v) => (
                  <SelectItem key={v} value={String(v)}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {placementChecks.length ? (
        <div className='space-y-1 rounded-md border border-[color:var(--status-bad)]/40 p-2'>
          <p className='text-xs text-[color:var(--status-bad)]'>
            目标节点预检未通过：
          </p>
          <PreflightCheckList checks={placementChecks} />
        </div>
      ) : null}

      <div className='flex items-center justify-end gap-2 pt-1'>
        {create.error ? (
          <p className='me-auto text-xs text-[color:var(--status-bad)]'>
            {importErrorMessage(create.error)}
          </p>
        ) : null}
        {onCancel ? (
          <Button variant='outline' onClick={onCancel}>
            取消
          </Button>
        ) : null}
        <Button
          onClick={() => create.mutate()}
          disabled={
            create.isPending || placement.blocked || remoteGpt || kvmBlocked
          }
          loading={create.isPending}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}

/** `CreateVmFields` 的弹窗外壳，给槽位列表页用。 */
export function CreateVmDialog({
  open,
  onOpenChange,
  defaultAfter,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultAfter?: CreateVmAfter
  onCreated?: (id: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>创建槽位</DialogTitle>
        </DialogHeader>
        <CreateVmFields
          defaultAfter={defaultAfter}
          onCancel={() => onOpenChange(false)}
          onCreated={(id) => {
            onOpenChange(false)
            onCreated?.(id)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

const KVM_HINT: Record<string, string> = {
  kvm_unavailable:
    '目标宿主没有可用的 /dev/kvm：需要裸机、开了嵌套虚拟化的 VPS，或 PVM 宿主内核。',
  kvm_arch_unsupported:
    'KVM 槽只支持 x86_64 宿主：槽内二进制只有 amd64，ARM 宿主的虚拟机里跑不了。',
  kvm_image_missing: '目标宿主还没有 KVM 槽镜像，先拉取后再创建。',
  docker_unavailable: '目标宿主的 Docker 无法启动探测容器。',
}

function KvmCapabilityNote({
  query,
}: {
  query: ReturnType<typeof useQuery<KvmCapability>>
}) {
  if (query.isFetching) {
    return <p className='text-xs text-muted-foreground'>正在检查目标宿主…</p>
  }
  if (query.data?.ok) {
    return (
      <p className='text-xs text-muted-foreground'>
        槽内进程跑在独立内核的微虚拟机里，出口与身份同容器槽一致。
      </p>
    )
  }
  const code = query.data?.code || ''
  const text =
    KVM_HINT[code] ||
    query.data?.error ||
    (query.error as Error | null)?.message
  return (
    <p className='text-xs text-destructive'>{text || '无法确认 KVM 可用'}</p>
  )
}
