import { createContext, useContext, useId, useState, type ComponentProps } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import {
  ArrowDownToLine,
  Bell,
  ExternalLink,
  Globe,
  Info,
  Languages,
  Minus,
  Monitor,
  PanelTop,
  Plus,
  Shield,
  UserCircle2,
  UserPen,
  Wifi,
  Wrench
} from 'lucide-react'
import type {
  AccentPreset,
  BrowsePageSize,
  DefaultHome,
  HistoryLimit,
  Locale,
  RepoOpenTarget,
  RepoSort,
  UiDensity
} from '@hubfetch/shared'
import { SUPPORTED_LOCALES } from '@hubfetch/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { ACCENT_SWATCH } from '@/lib/appearance'
import { changeLanguage } from '@/i18n'
import { cn, formatBytes } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useToasts } from '@/components/ui/toaster'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger as BaseSelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch as BaseSwitch } from '@/components/ui/switch'
import type { SettingsSection } from '@/stores/app'
import { resolveLocale, useAppStore } from '@/stores/app'
import { AccountSection } from '@/components/settings/AccountSection'
import { PrivacySection } from '@/components/settings/PrivacySection'
import { ProfileSection } from '@/components/settings/ProfileSection'
import { NetworkSection } from '@/components/settings/NetworkSection'
import { TranslationSection } from '@/components/settings/TranslationSection'
import { CloneToolsSection } from '@/components/settings/CloneToolsSection'
import { DesktopSection } from '@/components/settings/DesktopSection'

const REPO_URL = 'https://github.com/OranImp/HubFetch'
const SPEED_OPTIONS = [1, 5, 10, 20, 50] // MB/s
const UI_SCALE_MIN = 80
const UI_SCALE_MAX = 140
const UI_SCALE_STEP = 10
const FONT_SCALE_MIN = 90
const FONT_SCALE_MAX = 120
const FONT_SCALE_STEP = 5
const ACCENT_OPTIONS: AccentPreset[] = ['default', 'blue', 'green', 'orange', 'violet']
const PAGE_SIZE_OPTIONS: BrowsePageSize[] = [20, 30, 50]
const HISTORY_LIMIT_OPTIONS: HistoryLimit[] = [50, 100, 200, 500]

interface RowA11yContextValue {
  labelId: string
  descriptionId?: string
}

const RowA11yContext = createContext<RowA11yContextValue | undefined>(undefined)

function RowSelectTrigger(props: ComponentProps<typeof BaseSelectTrigger>): React.JSX.Element {
  const a11y = useContext(RowA11yContext)
  return (
    <BaseSelectTrigger
      {...props}
      aria-labelledby={props['aria-labelledby'] ?? a11y?.labelId}
      aria-describedby={props['aria-describedby'] ?? a11y?.descriptionId}
    />
  )
}

function RowSwitch(props: ComponentProps<typeof BaseSwitch>): React.JSX.Element {
  const a11y = useContext(RowA11yContext)
  return (
    <BaseSwitch
      {...props}
      aria-labelledby={props['aria-labelledby'] ?? a11y?.labelId}
      aria-describedby={props['aria-describedby'] ?? a11y?.descriptionId}
    />
  )
}

interface NavEntry {
  id: SettingsSection
  labelKey: string
  icon: React.ComponentType<{ className?: string }>
}

interface NavGroup {
  labelKey: string
  items: NavEntry[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'settings:groups.account',
    items: [
      { id: 'account', labelKey: 'settings:account.title', icon: UserCircle2 },
      { id: 'profile', labelKey: 'settings:profile.title', icon: UserPen }
    ]
  },
  {
    labelKey: 'settings:groups.interface',
    items: [
      { id: 'appearance', labelKey: 'settings:appearance.title', icon: Monitor },
      { id: 'downloads', labelKey: 'settings:downloads.title', icon: ArrowDownToLine },
      { id: 'notifications', labelKey: 'settings:notifications.title', icon: Bell }
    ]
  },
  {
    labelKey: 'settings:groups.connection',
    items: [
      { id: 'network', labelKey: 'settings:network.title', icon: Wifi },
      { id: 'translation', labelKey: 'settings:translation.title', icon: Languages },
      { id: 'cloneTools', labelKey: 'settings:cloneTools.title', icon: Wrench }
    ]
  },
  {
    labelKey: 'settings:groups.system',
    items: [{ id: 'desktop', labelKey: 'settings:desktop.title', icon: PanelTop }]
  },
  {
    labelKey: 'settings:groups.data',
    items: [{ id: 'privacy', labelKey: 'settings:privacy.title', icon: Shield }]
  },
  {
    labelKey: 'settings:groups.about',
    items: [{ id: 'about', labelKey: 'settings:about.title', icon: Info }]
  }
]

function SectionShell({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-smd font-semibold text-ink-strong">{title}</h2>
      {children}
    </section>
  )
}

function Row({
  label,
  description,
  children
}: {
  label: string
  /** Optional secondary line under the label. */
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  const labelId = `${id}-label`
  const descriptionId = description ? `${id}-description` : undefined

  return (
    <div className="flex min-h-8 items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-[13px] text-ink-muted">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="text-[11.5px] text-ink-faint">
            {description}
          </span>
        ) : null}
      </div>
      <RowA11yContext.Provider value={{ labelId, descriptionId }}>
        {children}
      </RowA11yContext.Provider>
    </div>
  )
}

function AppearanceSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common', 'browse'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const setLocale = (value: string): void => {
    const locale = value as 'system' | Locale
    void updateSettings({ locale }).then(() => {
      changeLanguage(resolveLocale({ ...settings, locale }, appInfo))
    })
  }

  const stepUiScale = (delta: number): void => {
    const uiScale = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, settings.uiScale + delta))
    if (uiScale !== settings.uiScale) void updateSettings({ uiScale })
  }

  const stepFontScale = (delta: number): void => {
    const fontScale = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, settings.fontScale + delta))
    if (fontScale !== settings.fontScale) void updateSettings({ fontScale })
  }

  const homeOptions: DefaultHome[] = ['home', 'models', 'datasets', 'spaces', 'papers']
  const sortOptions: RepoSort[] = ['trending', 'downloads', 'likes', 'updated', 'created']

  return (
    <SectionShell title={t('settings:appearance.title')}>
      <Row label={t('settings:appearance.language')}>
        <Select value={settings.locale} onValueChange={setLocale}>
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t('common:language.system')}</SelectItem>
            {SUPPORTED_LOCALES.map((locale) => (
              <SelectItem key={locale} value={locale}>
                {t(`common:language.${locale}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('common:theme.label')}>
        <Select
          value={settings.theme}
          onValueChange={(theme) => void updateSettings({ theme: theme as typeof settings.theme })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t('common:theme.system')}</SelectItem>
            <SelectItem value="light">{t('common:theme.light')}</SelectItem>
            <SelectItem value="dark">{t('common:theme.dark')}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.uiScale')}>
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.uiScaleDecrease')}
            disabled={settings.uiScale <= UI_SCALE_MIN}
            onClick={() => stepUiScale(-UI_SCALE_STEP)}
          >
            <Minus className="size-3.5" aria-hidden />
          </Button>
          <span className="nums w-12 text-center text-[13px]">{settings.uiScale}%</span>
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.uiScaleIncrease')}
            disabled={settings.uiScale >= UI_SCALE_MAX}
            onClick={() => stepUiScale(UI_SCALE_STEP)}
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </div>
      </Row>
      <Row label={t('settings:appearance.fontScale')}>
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.fontScaleDecrease')}
            disabled={settings.fontScale <= FONT_SCALE_MIN}
            onClick={() => stepFontScale(-FONT_SCALE_STEP)}
          >
            <Minus className="size-3.5" aria-hidden />
          </Button>
          <span className="nums w-12 text-center text-[13px]">{settings.fontScale}%</span>
          <Button
            variant="secondary"
            size="sm"
            className="w-7 px-0"
            aria-label={t('settings:appearance.fontScaleIncrease')}
            disabled={settings.fontScale >= FONT_SCALE_MAX}
            onClick={() => stepFontScale(FONT_SCALE_STEP)}
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </div>
      </Row>
      <Row label={t('settings:appearance.density')}>
        <Select
          value={settings.uiDensity}
          onValueChange={(v) => void updateSettings({ uiDensity: v as UiDensity })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">
              {t('settings:appearance.densityOptions.comfortable')}
            </SelectItem>
            <SelectItem value="compact">
              {t('settings:appearance.densityOptions.compact')}
            </SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.accent')}>
        <div
          className="flex items-center gap-1.5"
          role="radiogroup"
          aria-label={t('settings:appearance.accent')}
        >
          {ACCENT_OPTIONS.map((accent) => {
            const selected = settings.accent === accent
            const color = ACCENT_SWATCH[accent]
            return (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(`settings:appearance.accentOptions.${accent}`)}
                title={t(`settings:appearance.accentOptions.${accent}`)}
                className={cn(
                  'size-6 rounded-full border-2 transition-[box-shadow,border-color]',
                  selected ? 'border-bg' : 'border-border hover:border-ink-muted'
                )}
                style={{
                  background: color,
                  boxShadow: selected ? `0 0 0 2px ${color}` : undefined
                }}
                onClick={() => void updateSettings({ accent })}
              />
            )
          })}
        </div>
      </Row>
      <Row label={t('settings:appearance.sidebarCollapsed')}>
        <RowSwitch
          checked={settings.sidebarCollapsed}
          onCheckedChange={(sidebarCollapsed) => void updateSettings({ sidebarCollapsed })}
        />
      </Row>
      <Row label={t('settings:appearance.defaultHome')}>
        <Select
          value={settings.defaultHome}
          onValueChange={(v) => void updateSettings({ defaultHome: v as DefaultHome })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {homeOptions.map((home) => (
              <SelectItem key={home} value={home}>
                {t(`settings:appearance.homeOptions.${home}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.defaultSort')}>
        <Select
          value={settings.defaultRepoSort}
          onValueChange={(v) => void updateSettings({ defaultRepoSort: v as RepoSort })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {sortOptions.map((sort) => (
              <SelectItem key={sort} value={sort}>
                {t(`browse:sort.${sort}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.browsePageSize')}>
        <Select
          value={String(settings.browsePageSize)}
          onValueChange={(v) =>
            void updateSettings({ browsePageSize: Number(v) as BrowsePageSize })
          }
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t('settings:appearance.browsePageSizeOption', { count: n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.repoOpenTarget')}>
        <Select
          value={settings.repoOpenTarget}
          onValueChange={(v) => void updateSettings({ repoOpenTarget: v as RepoOpenTarget })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="app">{t('settings:appearance.openTarget.app')}</SelectItem>
            <SelectItem value="browser">{t('settings:appearance.openTarget.browser')}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:appearance.historyLimit')}>
        <Select
          value={String(settings.historyLimit)}
          onValueChange={(v) => void updateSettings({ historyLimit: Number(v) as HistoryLimit })}
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {HISTORY_LIMIT_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t('settings:appearance.historyLimitOption', { count: n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </SectionShell>
  )
}

function DownloadsSection(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const settings = useAppStore((s) => s.settings)
  const appInfo = useAppStore((s) => s.appInfo)
  const setSettings = useAppStore((s) => s.setSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const push = useToasts((s) => s.push)

  const pickCacheDir = useMutation({
    mutationFn: () => invoke('settings:selectCacheDir', undefined),
    onSuccess: (next) => {
      if (next) setSettings(next)
    },
    onError: (error) => push(error.message, 'error')
  })
  const resetCacheDir = useMutation({
    mutationFn: () => invoke('settings:resetCacheDir', undefined),
    onSuccess: setSettings,
    onError: (error) => push(error.message, 'error')
  })

  return (
    <SectionShell title={t('settings:downloads.title')}>
      <Row label={t('settings:downloads.concurrency')}>
        <Select
          value={String(settings.downloadConcurrency)}
          onValueChange={(v) => void updateSettings({ downloadConcurrency: Number(v) })}
        >
          <RowSelectTrigger className="w-24">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {String(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:downloads.speedLimit')}>
        <Select
          value={settings.speedLimitBps === null ? 'unlimited' : String(settings.speedLimitBps)}
          onValueChange={(v) =>
            void updateSettings({ speedLimitBps: v === 'unlimited' ? null : Number(v) })
          }
        >
          <RowSelectTrigger className="w-44">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            <SelectItem value="unlimited">{t('settings:downloads.unlimited')}</SelectItem>
            {SPEED_OPTIONS.map((mb) => (
              <SelectItem key={mb} value={String(mb * 1024 * 1024)}>
                {t('settings:downloads.speedPerSecond', {
                  value: formatBytes(mb * 1024 * 1024)
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('settings:downloads.cacheDir')}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="max-w-56 truncate font-mono text-[11.5px] text-ink-faint"
            title={settings.hfCacheDir ?? appInfo?.hfCacheDir}
          >
            {settings.hfCacheDir ?? t('settings:downloads.cacheDirDefault')}
          </span>
          <Button variant="secondary" size="sm" onClick={() => pickCacheDir.mutate()}>
            {t('settings:downloads.choose')}
          </Button>
          {settings.hfCacheDir && (
            <Button
              variant="ghost"
              size="sm"
              loading={resetCacheDir.isPending}
              onClick={() => resetCacheDir.mutate()}
            >
              {t('settings:downloads.reset')}
            </Button>
          )}
        </div>
      </Row>
    </SectionShell>
  )
}

function NotificationsSection(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <SectionShell title={t('settings:notifications.title')}>
      <Row label={t('settings:notifications.enabled')}>
        <RowSwitch
          checked={settings.notificationsEnabled}
          onCheckedChange={(notificationsEnabled) => void updateSettings({ notificationsEnabled })}
        />
      </Row>
      <Row label={t('settings:notifications.pollInterval')}>
        <Select
          value={String(settings.pollIntervalMinutes)}
          onValueChange={(v) => void updateSettings({ pollIntervalMinutes: Number(v) })}
        >
          <RowSelectTrigger className="w-32">
            <SelectValue />
          </RowSelectTrigger>
          <SelectContent>
            {[15, 30, 60, 180, 360].map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {t('settings:notifications.minutes', { count: minutes })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </SectionShell>
  )
}

function AboutSection(): React.JSX.Element {
  const { t } = useTranslation(['settings', 'common'])
  const appInfo = useAppStore((s) => s.appInfo)

  return (
    <SectionShell title={t('settings:about.title')}>
      <div className="flex flex-col gap-2 text-[12.5px]">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-ink-strong">{t('common:appName')}</span>
          <Badge variant="warning">{t('settings:about.unofficialTitle')}</Badge>
          {appInfo && (
            <span className="nums text-ink-faint">
              {t('settings:about.version', { version: appInfo.version })}
            </span>
          )}
        </div>
        {appInfo && (
          <p className="text-ink-muted">
            {t('settings:about.notificationRegistration', {
              status: t(
                `settings:about.notificationStatus.${appInfo.notificationRegistration.status}`
              )
            })}
          </p>
        )}
        <p className="max-w-[65ch] text-ink-muted">{t('settings:about.disclaimer')}</p>
        <p className="max-w-[65ch] text-ink-muted">{t('settings:about.privacy')}</p>
        <div className="mt-1 flex items-center gap-3">
          <span className="text-ink-faint">{t('settings:about.license')}</span>
          <button
            type="button"
            className="flex items-center gap-1 text-link hover:underline"
            onClick={() => openExternal(REPO_URL)}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('settings:about.github')}
          </button>
        </div>
      </div>
    </SectionShell>
  )
}

const SECTION_CONTENT: Record<SettingsSection, () => React.JSX.Element> = {
  account: AccountSection,
  profile: ProfileSection,
  appearance: AppearanceSection,
  downloads: DownloadsSection,
  notifications: NotificationsSection,
  network: NetworkSection,
  translation: TranslationSection,
  cloneTools: CloneToolsSection,
  desktop: DesktopSection,
  privacy: PrivacySection,
  about: AboutSection
}

export function SettingsDialog(): React.JSX.Element {
  const { t } = useTranslation(['settings'])
  const open = useAppStore((s) => s.settingsOpen)
  const section = useAppStore((s) => s.settingsSection)
  const openSettings = useAppStore((s) => s.openSettings)
  const closeSettings = useAppStore((s) => s.closeSettings)

  const Content = SECTION_CONTENT[section]

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openSettings() : closeSettings())}>
      <DialogContent
        aria-describedby={undefined}
        className="grid h-[34rem] max-h-[calc(100vh-6rem)] w-[56rem] max-w-[calc(100vw-4rem)] grid-cols-[13rem_1fr] overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t('settings:title')}</DialogTitle>
        <nav className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r bg-panel p-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.labelKey} className="flex flex-col gap-0.5">
              <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">
                {t(group.labelKey)}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openSettings(item.id)}
                  className={cn(
                    'flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors duration-150',
                    section === item.id
                      ? 'bg-panel-2 text-ink-strong'
                      : 'text-ink-muted hover:bg-panel-2 hover:text-ink'
                  )}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-left">{t(item.labelKey)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-h-0 overflow-y-auto p-6">
          <Content />
        </div>
      </DialogContent>
    </Dialog>
  )
}
