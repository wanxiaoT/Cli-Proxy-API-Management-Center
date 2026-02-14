/**
 * Codex 凭证管理页面
 * - 凭证列表展示（状态/余额/使用量）
 * - 搜索和过滤（按前缀、状态、模型）
 * - 批量启用/禁用
 * - 使用统计图表
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    Title,
    Tooltip,
    Legend,
} from 'chart.js';
import { Bar } from 'react-chartjs-2';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { IconSearch } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { providersApi } from '@/services/api';
import {
    useAuthStore,
    useConfigStore,
    useNotificationStore,
    useThemeStore,
} from '@/stores';
import { useProviderStats } from '@/components/providers/hooks/useProviderStats';
import {
    hasDisableAllModelsRule,
    withDisableAllModelsRule,
    withoutDisableAllModelsRule,
    getStatsBySource,
} from '@/components/providers/utils';
import { maskApiKey } from '@/utils/format';
import type { ProviderKeyConfig } from '@/types';
import type { KeyStatBucket } from '@/utils/usage';
import styles from './CodexCredentialsPage.module.scss';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type StatusFilter = 'all' | 'active' | 'disabled';

interface CredentialItem extends ProviderKeyConfig {
    _index: number;
    _disabled: boolean;
    _stats: KeyStatBucket;
}

export function CodexCredentialsPage() {
    const { t } = useTranslation();
    const { showNotification } = useNotificationStore();
    const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
    const isDark = resolvedTheme === 'dark';
    const connectionStatus = useAuthStore((state) => state.connectionStatus);
    const disableControls = connectionStatus !== 'connected';

    const fetchConfig = useConfigStore((state) => state.fetchConfig);
    const updateConfigValue = useConfigStore((state) => state.updateConfigValue);
    const clearCache = useConfigStore((state) => state.clearCache);
    const config = useConfigStore((state) => state.config);

    const [configs, setConfigs] = useState<ProviderKeyConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const hasMounted = useRef(false);

    // 搜索和过滤
    const [searchText, setSearchText] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [prefixFilter, setPrefixFilter] = useState('');

    // 批量选择
    const [selectedKeys, setSelectedKeys] = useState<Set<number>>(new Set());

    // 使用统计
    const { keyStats, loadKeyStats } = useProviderStats();

    // 加载凭证列表
    const loadConfigs = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await fetchConfig('codex-api-key');
            const list = Array.isArray(data) ? (data as ProviderKeyConfig[]) : [];
            setConfigs(list);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : t('notification.refresh_failed');
            setError(msg);
        } finally {
            setLoading(false);
        }
    }, [fetchConfig, t]);

    const handleRefresh = useCallback(async () => {
        await Promise.all([loadConfigs(), loadKeyStats()]);
    }, [loadConfigs, loadKeyStats]);

    useHeaderRefresh(handleRefresh);

    useEffect(() => {
        if (hasMounted.current) return;
        hasMounted.current = true;
        void loadConfigs();
        void loadKeyStats();
    }, [loadConfigs, loadKeyStats]);

    // 同步 config store 更新
    useEffect(() => {
        if (config?.codexApiKeys) {
            setConfigs(config.codexApiKeys);
        }
    }, [config?.codexApiKeys]);

    // 构建增强的凭证列表
    const credentialItems: CredentialItem[] = useMemo(
        () =>
            configs.map((cfg, idx) => ({
                ...cfg,
                _index: idx,
                _disabled: hasDisableAllModelsRule(cfg.excludedModels),
                _stats: getStatsBySource(cfg.apiKey, keyStats, cfg.prefix),
            })),
        [configs, keyStats]
    );

    // 可用前缀列表
    const prefixOptions = useMemo(() => {
        const prefixes = new Set<string>();
        configs.forEach((cfg) => {
            if (cfg.prefix?.trim()) prefixes.add(cfg.prefix.trim());
        });
        return [
            { value: '', label: t('codex_credentials.filter_all_prefix') },
            ...Array.from(prefixes)
                .sort()
                .map((p) => ({ value: p, label: p })),
        ];
    }, [configs, t]);

    // 状态过滤选项
    const statusOptions = useMemo(
        () => [
            { value: 'all', label: t('codex_credentials.filter_all_status') },
            { value: 'active', label: t('codex_credentials.filter_active') },
            { value: 'disabled', label: t('codex_credentials.filter_disabled') },
        ],
        [t]
    );

    // 过滤后的凭证列表
    const filteredItems = useMemo(() => {
        let items = credentialItems;

        // 搜索（按 apiKey、baseUrl、prefix）
        if (searchText.trim()) {
            const kw = searchText.trim().toLowerCase();
            items = items.filter(
                (item) =>
                    item.apiKey.toLowerCase().includes(kw) ||
                    (item.baseUrl ?? '').toLowerCase().includes(kw) ||
                    (item.prefix ?? '').toLowerCase().includes(kw)
            );
        }

        // 状态过滤
        if (statusFilter === 'active') {
            items = items.filter((item) => !item._disabled);
        } else if (statusFilter === 'disabled') {
            items = items.filter((item) => item._disabled);
        }

        // 前缀过滤
        if (prefixFilter) {
            items = items.filter((item) => item.prefix?.trim() === prefixFilter);
        }

        return items;
    }, [credentialItems, searchText, statusFilter, prefixFilter]);

    // 统计数据
    const totalCount = configs.length;
    const activeCount = credentialItems.filter((c) => !c._disabled).length;
    const disabledCount = credentialItems.filter((c) => c._disabled).length;
    const totalSuccess = credentialItems.reduce((sum, c) => sum + c._stats.success, 0);

    // 切换启用/禁用
    const toggleConfig = useCallback(
        async (index: number, enabled: boolean) => {
            if (disableControls || saving) return;
            setSaving(true);
            const previousList = configs;
            const current = configs[index];
            if (!current) {
                setSaving(false);
                return;
            }
            const nextExcluded = enabled
                ? withoutDisableAllModelsRule(current.excludedModels)
                : withDisableAllModelsRule(current.excludedModels);
            const nextItem: ProviderKeyConfig = { ...current, excludedModels: nextExcluded };
            const nextList = configs.map((item, idx) => (idx === index ? nextItem : item));
            setConfigs(nextList);
            updateConfigValue('codex-api-key', nextList);
            clearCache('codex-api-key');
            try {
                await providersApi.saveCodexConfigs(nextList);
                showNotification(
                    enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
                    'success'
                );
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : '';
                setConfigs(previousList);
                updateConfigValue('codex-api-key', previousList);
                clearCache('codex-api-key');
                showNotification(`${t('notification.update_failed')}: ${msg}`, 'error');
            } finally {
                setSaving(false);
            }
        },
        [configs, clearCache, disableControls, saving, showNotification, t, updateConfigValue]
    );

    // 批量启用/禁用
    const batchToggle = useCallback(
        async (enabled: boolean) => {
            if (disableControls || saving || selectedKeys.size === 0) return;
            setSaving(true);
            const previousList = configs;
            const nextList = configs.map((item, idx) => {
                if (!selectedKeys.has(idx)) return item;
                const nextExcluded = enabled
                    ? withoutDisableAllModelsRule(item.excludedModels)
                    : withDisableAllModelsRule(item.excludedModels);
                return { ...item, excludedModels: nextExcluded };
            });
            setConfigs(nextList);
            updateConfigValue('codex-api-key', nextList);
            clearCache('codex-api-key');
            try {
                await providersApi.saveCodexConfigs(nextList);
                showNotification(
                    t('codex_credentials.batch_success', { count: selectedKeys.size }),
                    'success'
                );
                setSelectedKeys(new Set());
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : '';
                setConfigs(previousList);
                updateConfigValue('codex-api-key', previousList);
                clearCache('codex-api-key');
                showNotification(`${t('notification.update_failed')}: ${msg}`, 'error');
            } finally {
                setSaving(false);
            }
        },
        [configs, clearCache, disableControls, saving, selectedKeys, showNotification, t, updateConfigValue]
    );

    // 全选/反选
    const toggleSelectAll = useCallback(() => {
        if (selectedKeys.size === filteredItems.length) {
            setSelectedKeys(new Set());
        } else {
            setSelectedKeys(new Set(filteredItems.map((i) => i._index)));
        }
    }, [filteredItems, selectedKeys.size]);

    const toggleSelect = useCallback((index: number) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    }, []);

    // ===== 图表数据 =====
    const chartData = useMemo(() => {
        const labels: string[] = [];
        const successData: number[] = [];
        const failureData: number[] = [];

        credentialItems.forEach((item) => {
            const label = item.prefix || maskApiKey(item.apiKey);
            labels.push(label);
            successData.push(item._stats.success);
            failureData.push(item._stats.failure);
        });

        return {
            labels,
            datasets: [
                {
                    label: t('codex_credentials.chart_success'),
                    data: successData,
                    backgroundColor: isDark ? 'rgba(52, 211, 153, 0.7)' : 'rgba(16, 185, 129, 0.7)',
                    borderColor: isDark ? '#34d399' : '#10b981',
                    borderWidth: 1,
                    borderRadius: 4,
                },
                {
                    label: t('codex_credentials.chart_failure'),
                    data: failureData,
                    backgroundColor: isDark ? 'rgba(248, 113, 113, 0.7)' : 'rgba(239, 68, 68, 0.7)',
                    borderColor: isDark ? '#f87171' : '#ef4444',
                    borderWidth: 1,
                    borderRadius: 4,
                },
            ],
        };
    }, [credentialItems, isDark, t]);

    const chartOptions = useMemo(
        () => ({
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top' as const,
                    labels: {
                        color: isDark ? '#d1d5db' : '#4b5563',
                        font: { size: 12 },
                        usePointStyle: true,
                        pointStyle: 'rectRounded' as const,
                    },
                },
                tooltip: {
                    backgroundColor: isDark ? '#1f2937' : '#ffffff',
                    titleColor: isDark ? '#f9fafb' : '#111827',
                    bodyColor: isDark ? '#d1d5db' : '#4b5563',
                    borderColor: isDark ? '#374151' : '#e5e7eb',
                    borderWidth: 1,
                    cornerRadius: 8,
                    padding: 10,
                },
            },
            scales: {
                x: {
                    ticks: {
                        color: isDark ? '#9ca3af' : '#6b7280',
                        font: { size: 11 },
                        maxRotation: 45,
                    },
                    grid: { display: false },
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: isDark ? '#9ca3af' : '#6b7280',
                        font: { size: 11 },
                        precision: 0,
                    },
                    grid: {
                        color: isDark ? 'rgba(75, 85, 99, 0.3)' : 'rgba(229, 231, 235, 0.8)',
                    },
                },
            },
        }),
        [isDark]
    );

    return (
        <div className={styles.container}>
            {/* 页面头部 */}
            <div className={styles.pageHeader}>
                <h1 className={styles.pageTitle}>{t('codex_credentials.title')}</h1>
                <p className={styles.description}>{t('codex_credentials.description')}</p>
            </div>

            {error && <div className={styles.errorBox}>{error}</div>}

            {/* 统计概览 */}
            <div className={styles.statsRow}>
                <div className={`${styles.statCard} ${styles.statCardTotal}`}>
                    <span className={styles.statLabel}>{t('codex_credentials.stat_total')}</span>
                    <span className={styles.statValue}>{totalCount}</span>
                </div>
                <div className={`${styles.statCard} ${styles.statCardActive}`}>
                    <span className={styles.statLabel}>{t('codex_credentials.stat_active')}</span>
                    <span className={styles.statValue}>{activeCount}</span>
                </div>
                <div className={`${styles.statCard} ${styles.statCardDisabled}`}>
                    <span className={styles.statLabel}>{t('codex_credentials.stat_disabled')}</span>
                    <span className={styles.statValue}>{disabledCount}</span>
                </div>
                <div className={`${styles.statCard} ${styles.statCardSuccess}`}>
                    <span className={styles.statLabel}>{t('codex_credentials.stat_total_success')}</span>
                    <span className={styles.statValue}>{totalSuccess}</span>
                </div>
            </div>

            {/* 工具栏 */}
            <div className={styles.toolbar}>
                <div className={styles.searchBox}>
                    <span className={styles.searchIcon}>
                        <IconSearch size={14} />
                    </span>
                    <input
                        className={styles.searchInput}
                        type="text"
                        placeholder={t('codex_credentials.search_placeholder')}
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                    />
                </div>

                <div className={styles.filterGroup}>
                    <span className={styles.filterLabel}>{t('codex_credentials.filter_status_label')}</span>
                    <Select
                        value={statusFilter}
                        options={statusOptions}
                        onChange={(val) => setStatusFilter(val as StatusFilter)}
                        fullWidth={false}
                        ariaLabel={t('codex_credentials.filter_status_label')}
                    />
                </div>

                {prefixOptions.length > 1 && (
                    <div className={styles.filterGroup}>
                        <span className={styles.filterLabel}>{t('codex_credentials.filter_prefix_label')}</span>
                        <Select
                            value={prefixFilter}
                            options={prefixOptions}
                            onChange={setPrefixFilter}
                            fullWidth={false}
                            ariaLabel={t('codex_credentials.filter_prefix_label')}
                        />
                    </div>
                )}

                <div className={styles.batchActions}>
                    {filteredItems.length > 0 && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={toggleSelectAll}
                            disabled={disableControls}
                        >
                            {selectedKeys.size === filteredItems.length
                                ? t('codex_credentials.deselect_all')
                                : t('codex_credentials.select_all')}
                        </Button>
                    )}
                    {selectedKeys.size > 0 && (
                        <>
                            <span className={styles.selectedCount}>
                                {t('codex_credentials.selected_count', { count: selectedKeys.size })}
                            </span>
                            <Button
                                size="sm"
                                onClick={() => void batchToggle(true)}
                                loading={saving}
                                disabled={disableControls}
                            >
                                {t('codex_credentials.batch_enable')}
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void batchToggle(false)}
                                loading={saving}
                                disabled={disableControls}
                            >
                                {t('codex_credentials.batch_disable')}
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {/* 凭证列表 */}
            {loading && !configs.length ? (
                <div className={styles.loadingOverlay}>
                    <LoadingSpinner size={24} />
                    <span>{t('common.loading')}</span>
                </div>
            ) : filteredItems.length === 0 ? (
                <div className={styles.emptyState}>
                    <div className={styles.emptyTitle}>
                        {configs.length === 0
                            ? t('codex_credentials.empty_title')
                            : t('codex_credentials.filter_empty_title')}
                    </div>
                    <div className={styles.emptyDesc}>
                        {configs.length === 0
                            ? t('codex_credentials.empty_desc')
                            : t('codex_credentials.filter_empty_desc')}
                    </div>
                </div>
            ) : (
                <div className={styles.credentialGrid}>
                    {filteredItems.map((item) => {
                        const isSelected = selectedKeys.has(item._index);
                        const excludedModels = (item.excludedModels ?? []).filter(
                            (m) => m.trim() !== '*'
                        );
                        return (
                            <div
                                key={`codex-${item._index}`}
                                className={[
                                    styles.credentialCard,
                                    item._disabled ? styles.credentialCardDisabled : '',
                                    isSelected ? styles.credentialCardSelected : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                            >
                                {/* 顶部行 */}
                                <div className={styles.cardTopRow}>
                                    <input
                                        type="checkbox"
                                        className={styles.cardCheckbox}
                                        checked={isSelected}
                                        onChange={() => toggleSelect(item._index)}
                                        aria-label={t('codex_credentials.select_credential')}
                                    />
                                    <span className={styles.cardKey}>{maskApiKey(item.apiKey)}</span>
                                    <div className={styles.cardActions}>
                                        <span
                                            className={`${styles.statusBadge} ${item._disabled ? styles.statusDisabled : styles.statusActive}`}
                                        >
                                            {item._disabled
                                                ? t('codex_credentials.status_disabled')
                                                : t('codex_credentials.status_active')}
                                        </span>
                                        <ToggleSwitch
                                            checked={!item._disabled}
                                            onChange={(val) => void toggleConfig(item._index, val)}
                                            disabled={disableControls || saving}
                                            ariaLabel={t('ai_providers.config_toggle_label')}
                                        />
                                    </div>
                                </div>

                                {/* 详细信息 */}
                                {item.prefix && (
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>{t('common.prefix')}:</span>
                                        <span className={styles.fieldValue}>{item.prefix}</span>
                                    </div>
                                )}
                                {item.baseUrl && (
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>{t('common.base_url')}:</span>
                                        <span className={styles.fieldValue}>{item.baseUrl}</span>
                                    </div>
                                )}
                                {item.proxyUrl && (
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>{t('common.proxy_url')}:</span>
                                        <span className={styles.fieldValue}>{item.proxyUrl}</span>
                                    </div>
                                )}

                                {/* 排除模型 */}
                                {excludedModels.length > 0 && (
                                    <div className={styles.excludedSection}>
                                        <div className={styles.excludedLabel}>
                                            {t('ai_providers.excluded_models_count', { count: excludedModels.length })}
                                        </div>
                                        <div className={styles.modelTagList}>
                                            {excludedModels.map((model) => (
                                                <span key={model} className={styles.modelTag}>
                                                    {model}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* 使用统计 */}
                                <div className={styles.cardStats}>
                                    <span className={`${styles.statPill} ${styles.statPillSuccess}`}>
                                        {t('codex_credentials.chart_success')}: {item._stats.success}
                                    </span>
                                    <span className={`${styles.statPill} ${styles.statPillFailure}`}>
                                        {t('codex_credentials.chart_failure')}: {item._stats.failure}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 使用统计图表 */}
            {credentialItems.length > 0 && (
                <div className={styles.chartSection}>
                    <div className={styles.chartHeader}>
                        <h2 className={styles.chartTitle}>{t('codex_credentials.chart_title')}</h2>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleRefresh()}
                            disabled={loading}
                        >
                            {t('common.refresh')}
                        </Button>
                    </div>
                    <div className={styles.chartContainer}>
                        <Bar data={chartData} options={chartOptions} />
                    </div>
                </div>
            )}
        </div>
    );
}
