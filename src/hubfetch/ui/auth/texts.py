"""Bilingual vocabulary for the auth management surface, resolved by locale.

Todo 28 migrates every UI literal of the authentication surface into this
single bilingual vocabulary (Simplified Chinese default, complete English
fallback) exactly as the Settings/Create vocabularies do, so the localization
coverage gate can prove both locales are complete and no prose literal bypasses
the vocabulary. Display code requests labels through this value object and never
hard-codes localized text.
"""

from __future__ import annotations

from dataclasses import dataclass

from hubfetch.config.settings import Locale


@dataclass(frozen=True, slots=True)
class AuthTexts:
    """Complete bilingual vocabulary for the auth management surface."""

    title: str
    ownership_shared: str
    ownership_hubfetch: str
    ownership_anonymous: str
    account_label: str
    alias_label: str
    shared_account_label: str
    sign_in_browser: str
    add_token: str
    replace_command: str
    delete_command: str
    cancel_command: str
    confirm_command: str
    start_again_command: str
    save_token_command: str
    pending_title: str
    pending_code_label: str
    pending_uri_label: str
    pending_expiry_label: str
    expired_message: str
    denied_message: str
    cancelled_message: str
    failed_message: str
    unavailable_message: str
    token_field_label: str
    token_placeholder: str
    replace_confirm_message: str
    delete_confirm_message: str
    metadata_shared_format: str
    metadata_hubfetch_format: str
    announcement_authenticated_format: str
    announcement_added_format: str
    announcement_replaced_format: str
    announcement_deleted_format: str

    @classmethod
    def for_locale(cls, locale: Locale) -> AuthTexts:
        """Return the complete vocabulary for one auth surface locale."""
        if locale is Locale.EN_US:
            return AuthTexts(
                title="Authentication",
                ownership_shared="Shared machine account",
                ownership_hubfetch="HubFetch-only token",
                ownership_anonymous="Not signed in",
                account_label="Account",
                alias_label="Credential alias",
                shared_account_label="Shared browser sign-in",
                sign_in_browser="Sign in with browser",
                add_token="Add HubFetch token",  # noqa: S106 - UI label, not a secret
                replace_command="Replace",
                delete_command="Delete",
                cancel_command="Cancel",
                confirm_command="Confirm",
                start_again_command="Start again",
                save_token_command="Save token",  # noqa: S106 - UI label, not a secret
                pending_title="Waiting for browser authorization",
                pending_code_label="Code",
                pending_uri_label="Verification page",
                pending_expiry_label="Expires in",
                expired_message="The sign-in code expired. Start again to continue.",
                denied_message="Authorization was denied in the browser.",
                cancelled_message="Sign-in was cancelled.",
                failed_message="Sign-in failed. Check your connection and try again.",
                unavailable_message=(
                    "Shared browser sign-in is unavailable on this machine."
                ),
                token_field_label="Access token",  # noqa: S106 - UI label, not a secret
                token_placeholder="Paste the HubFetch token here",  # noqa: S106 - UI label, not a secret
                replace_confirm_message=(
                    "Replace the stored HubFetch-only token? The previous value "
                    "cannot be recovered."
                ),
                delete_confirm_message=(
                    "Delete the stored HubFetch-only token? Shared machine "
                    "credentials are unaffected."
                ),
                metadata_shared_format="Account {username}, token {token_name}",
                metadata_hubfetch_format="Alias {alias}",
                announcement_authenticated_format="Signed in as {account}",
                announcement_added_format="Added HubFetch-only token",
                announcement_replaced_format="Replaced HubFetch-only token",
                announcement_deleted_format="Deleted HubFetch-only token",
            )
        return AuthTexts(
            title="身份验证",
            ownership_shared="共享机器账户",
            ownership_hubfetch="HubFetch 专属令牌",
            ownership_anonymous="未登录",
            account_label="账户",
            alias_label="凭据别名",
            shared_account_label="共享浏览器登录",
            sign_in_browser="使用浏览器登录",
            add_token="添加 HubFetch 令牌",  # noqa: S106 - UI label, not a secret
            replace_command="更换",
            delete_command="删除",
            cancel_command="取消",
            confirm_command="确认",
            start_again_command="重新开始",
            save_token_command="保存令牌",  # noqa: S106 - UI label, not a secret
            pending_title="等待浏览器授权",
            pending_code_label="代码",
            pending_uri_label="验证页面",
            pending_expiry_label="有效期限",
            expired_message="登录代码已过期，请重新开始以继续。",  # noqa: RUF001 - fullwidth comma in zh text
            denied_message="已在浏览器中拒绝授权。",
            cancelled_message="已取消登录。",
            failed_message="登录失败，请检查网络后重试。",  # noqa: RUF001 - fullwidth comma in zh text
            unavailable_message="当前机器不支持共享浏览器登录。",
            token_field_label="访问令牌",  # noqa: S106 - UI label, not a secret
            token_placeholder="在此粘贴 HubFetch 令牌",  # noqa: S106 - UI label, not a secret
            replace_confirm_message=(
                "是否更换已存储的 HubFetch 专属令牌？原值无法恢复。"  # noqa: RUF001 - fullwidth punctuation in zh text
            ),
            delete_confirm_message=(
                "是否删除已存储的 HubFetch 专属令牌？共享机器凭据不受影响。"  # noqa: RUF001 - fullwidth punctuation in zh text
            ),
            metadata_shared_format=(
                "账户 {username}，令牌 {token_name}"  # noqa: RUF001 - fullwidth punctuation in zh text
            ),
            metadata_hubfetch_format="别名 {alias}",
            announcement_authenticated_format="已以 {account} 身份登录",
            announcement_added_format="已添加 HubFetch 专属令牌",
            announcement_replaced_format="已更换 HubFetch 专属令牌",
            announcement_deleted_format="已删除 HubFetch 专属令牌",
        )


__all__ = ["AuthTexts"]
