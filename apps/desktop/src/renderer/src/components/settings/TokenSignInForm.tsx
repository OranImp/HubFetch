import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, KeyRound } from 'lucide-react'
import { hubSettingsUrl } from '@hubfetch/shared'
import { invoke, openExternal } from '@/lib/ipc'
import { applyAuthStateChange } from '@/lib/query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/stores/app'

/**
 * Paste-a-token sign-in. The token is a secret: password field, no
 * autocomplete, never echoed anywhere. The field clears on submit so the
 * secret does not linger in renderer state. Failures surface inline
 * (invalid vs network) — a failed paste never disturbs the current session.
 */
export function TokenSignInForm({
  onDone,
  submitMode = 'signIn'
}: {
  onDone?: () => void
  submitMode?: 'signIn' | 'add'
}): React.JSX.Element {
  const { t } = useTranslation(['auth'])
  const queryClient = useQueryClient()
  const setAuth = useAppStore((s) => s.setAuth)
  const endpoint = useAppStore((s) => s.settings.hubEndpoint)
  const [token, setToken] = useState('')
  const [error, setError] = useState<'invalid' | 'forbidden' | 'network' | null>(null)

  const submit = useMutation({
    mutationFn: (value: string) => invoke('auth:signInWithToken', { token: value }),
    onSuccess: (result) => {
      if (result.ok) {
        applyAuthStateChange(queryClient, useAppStore.getState().auth, result.state)
        setAuth(result.state)
        onDone?.()
      } else {
        setError(result.error)
      }
    },
    onError: () => setError('network')
  })

  return (
    <form
      className="flex max-w-96 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const value = token.trim()
        if (value === '' || submit.isPending) return
        setError(null)
        setToken('')
        submit.mutate(value)
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-[12.5px] font-medium text-ink-strong">
          {t('auth:tokenSignIn.label')}
        </span>
        <Input
          type="password"
          value={token}
          placeholder={t('auth:tokenSignIn.placeholder')}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null}
          onChange={(event) => {
            setToken(event.target.value)
            setError(null)
          }}
        />
        {error !== null && (
          <span className="text-[12px] text-error">{t(`auth:tokenSignIn.${error}`)}</span>
        )}
      </label>
      <p className="max-w-[65ch] text-[12px] text-ink-faint">{t('auth:tokenSignIn.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="cta"
          size="sm"
          loading={submit.isPending}
          disabled={token.trim() === ''}
        >
          <KeyRound className="size-3.5" aria-hidden />
          {submitMode === 'add' ? t('auth:tokenSignIn.addSubmit') : t('auth:tokenSignIn.submit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openExternal(hubSettingsUrl('tokens', endpoint))}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t('auth:tokenSignIn.createLink')}
        </Button>
      </div>
    </form>
  )
}
