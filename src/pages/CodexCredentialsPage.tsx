/**
 * Codex 凭证管理页面
 * 数据来源：认证文件 API（过滤 type === 'codex'）
 * - 凭证列表展示（状态/大小/修改时间）
 * - 搜索过滤
 * - 批量启用/禁用
 * - 使用统计（成功/失败）
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
import { authFilesApi } from '@/services/api';
import { usageApi } from '@/services/api';
import {
    useAuthStore,
    useNotificationStore,
    useThemeStore,
} from '@/stores';
import type { AuthFileItem } from '@/types';
import type { KeyStats } from '@/utils/usage';
import { collectUsageDetails, type UsageDetail } from '@/utils/usage';
import { formatFileSize } from '@/utils/format';
import styles from './CodexCredentialsPage.module.scss';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type StatusFilter = 'all' | 'active' | 'disabled';

export function CodexCredentialsPage() {
    const { t } = useTranslation();
    const { showNotification } = useNotificationStore();
    const resolvedTheme = useThemeStore((state: { resolvedTheme: string }) => state.resolvedTheme);
    const isDark = resolvedTheme === 'dark';
    const connectionStatus = useAuthStore((state: { connectionStatus: string }) => state.connectionStatus);
    const disableControls = connectionStatus !== 'connected';

    const [files, setFiles] = useState<AuthFileItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const hasMounted = useRef(false);

    // 使用统计
    const [keyStats, setKeyStats] = useState<KeyStats>({ bySource: {}, byAuthIndex: {} });
    const [usageDetails, setUsageDetails] = useState<UsageDetail[]>([]);

    // 搜索和过滤
    const [searchText, setSearchText] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

    // 批量选择
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

    // 加载认证文件列表（只保留 codex 类型）
    const loadFiles = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await authFilesApi.list();
            const allFiles = data?.files || [];
            const codexFiles = allFiles.filter(
                (f: AuthFileItem) => f.type === 'codex'
            );
            setFiles(codexFiles);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : t('notification.refresh_failed');
            setError(msg);
        } finally {
            setLoading(false);
        }
    }, [t]);

    // 加载使用统计
    const loadKeyStats = useCallback(async () => {
        try {
            const usageResponse = await usageApi.getUsage();
            const usageData = usageResponse?.usage ?? usageResponse;
            const stats = await usageApi.getKeyStats(usageData);
            setKeyStats(stats);
            const details = collectUsageDetails(usageData);
            setUsageDetails(details);
        } catch {
            // 静默失败
        }
    }, []);

    const handleRefresh = useCallback(async () => {
        await Promise.all([loadFiles(), loadKeyStats()]);
    }, [loadFiles, loadKeyStats]);

    useHeaderRefresh(handleRefresh);

    useEffect(() => {
        if (hasMounted.current) return;
        hasMounted.current = true;
        void loadFiles();
        void loadKeyStats();
    }, [loadFiles, loadKeyStats]);

    // 获取每个认证文件的使用统计
    const getFileStats = useCallback((file: AuthFileItem) => {
        const rawAuthIndex = file['auth_index'] ?? file.authIndex;
        const authIndexKey = rawAuthIndex != null ? String(rawAuthIndex).trim() : null;
        let success = 0;
        let failure = 0;

        if (authIndexKey) {
            usageDetails.forEach((detail: UsageDetail) => {
                const detailAuthIndex = detail.auth_index != null ? String(detail.auth_index).trim() : null;
                if (detailAuthIndex === authIndexKey) {
                    if (detail.status === 'success' || detail.status === 'ok') {
                        success++;
                    } else {
                        failure++;
                    }
                }
            });
        }

        // 也尝试通过 bySource 匹配
        const fileName = file.name.replace(/\.json$/, '');
        const sourceStats = keyStats.bySource?.[fileName];
        if (sourceStats) {
            success += sourceStats.success || 0;
            failure += sourceStats.failure || 0;
        }

        return { success, failure };
    }, [usageDetails, keyStats]);

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
        let items = files;

        // 搜索（按名称）
        if (searchText.trim()) {
            const kw = searchText.trim().toLowerCase();
            items = items.filter(
                (item: AuthFileItem) =>
                    item.name.toLowerCase().includes(kw) ||
                    (item.provider ?? '').toLowerCase().includes(kw)
            );
        }

        // 状态过滤
        if (statusFilter === 'active') {
            items = items.filter((item: AuthFileItem) => !item.disabled);
        } else if (statusFilter === 'disabled') {
            items = items.filter((item: AuthFileItem) => item.disabled === true);
        }

        return items;
    }, [files, searchText, statusFilter]);

    // 统计数据
    const totalCount = files.length;
    const activeCount = files.filter((f: AuthFileItem) => !f.disabled).length;
    const disabledCount = files.filter((f: AuthFileItem) => f.disabled === true).length;
    const totalSuccess = files.reduce((sum: number, f: AuthFileItem) => sum + getFileStats(f).success, 0);

    // 切换启用/禁用
    const toggleFile = useCallback(
        async (name: string, enabled: boolean) => {
            if (disableControls || saving) return;
            setSaving(true);
            const previousFiles = files;
            // 乐观更新
            setFiles((prev: AuthFileItem[]) =>
                prev.map((f: AuthFileItem) => (f.name === name ? { ...f, disabled: !enabled } : f))
            );
            try {
                await authFilesApi.setStatus(name, !enabled);
                showNotification(
                    enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
                    'success'
                );
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : '';
                setFiles(previousFiles);
                showNotification(`${t('notification.update_failed')}: ${msg}`, 'error');
            } finally {
                setSaving(false);
            }
        },
        [files, disableControls, saving, showNotification, t]
    );

    // 批量启用/禁用
    const batchToggle = useCallback(
        async (enabled: boolean) => {
            if (disableControls || saving || selectedKeys.size === 0) return;
            setSaving(true);
            const previousFiles = files;
            // 乐观更新
            setFiles((prev: AuthFileItem[]) =>
                prev.map((f: AuthFileItem) => (selectedKeys.has(f.name) ? { ...f, disabled: !enabled } : f))
            );
            let successCount = 0;
            let failCount = 0;
            for (const name of selectedKeys) {
                try {
                    await authFilesApi.setStatus(name, !enabled);
                    successCount++;
                } catch {
                    failCount++;
                }
            }
            if (failCount > 0) {
                setFiles(previousFiles);
                showNotification(
                    t('codex_credentials.batch_partial', { success: successCount, fail: failCount }),
                    'warning'
                );
            } else {
                showNotification(
                    t('codex_credentials.batch_success', { count: selectedKeys.size }),
                    'success'
                );
            }
            setSelectedKeys(new Set());
            setSaving(false);
        },
        [files, disableControls, saving, selectedKeys, showNotification, t]
    );

    // 全选/反选
    const toggleSelectAll = useCallback(() => {
        if (selectedKeys.size === filteredItems.length) {
            setSelectedKeys(new Set());
        } else {
            setSelectedKeys(new Set(filteredItems.map((i: AuthFileItem) => i.name)));
        }
    }, [filteredItems, selectedKeys.size]);

    const toggleSelect = useCallback((name: string) => {
        setSelectedKeys((prev: Set<string>) => {
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
            } else {
                next.add(name);
            }
            return next;
        });
    }, []);

    // 格式化修改时间
    const formatTime = (ts?: number) => {
        if (!ts) return '-';
        return new Date(ts).toLocaleString();
    };

    // ===== 图表数据 =====
    const chartData = useMemo(() => {
        const labels: string[] = [];
        const successData: number[] = [];
        const failureData: number[] = [];

        // 只展示前 20 个有数据的
        const itemsWithStats = files
            .map((f: AuthFileItem) => ({ file: f, stats: getFileStats(f) }))
            .filter((item) => item.stats.success > 0 || item.stats.failure > 0)
            .slice(0, 20);

        itemsWithStats.forEach((item) => {
            const label = item.file.name.replace(/\.json$/, '').slice(0, 20);
            labels.push(label);
            successData.push(item.stats.success);
            failureData.push(item.stats.failure);
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
    }, [files, getFileStats, isDark, t]);

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
            {loading && !files.length ? (
                <div className={styles.loadingOverlay}>
                    <LoadingSpinner size={24} />
                    <span>{t('common.loading')}</span>
                </div>
            ) : filteredItems.length === 0 ? (
                <div className={styles.emptyState}>
                    <div className={styles.emptyTitle}>
                        {files.length === 0
                            ? t('codex_credentials.empty_title')
                            : t('codex_credentials.filter_empty_title')}
                    </div>
                    <div className={styles.emptyDesc}>
                        {files.length === 0
                            ? t('codex_credentials.empty_desc')
                            : t('codex_credentials.filter_empty_desc')}
                    </div>
                </div>
            ) : (
                <div className={styles.credentialGrid}>
                    {filteredItems.map((item: AuthFileItem) => {
                        const isSelected = selectedKeys.has(item.name);
                        const stats = getFileStats(item);
                        return (
                            <div
                                key={item.name}
                                className={[
                                    styles.credentialCard,
                                    item.disabled ? styles.credentialCardDisabled : '',
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
                                        onChange={() => toggleSelect(item.name)}
                                        aria-label={t('codex_credentials.select_credential')}
                                    />
                                    <span className={styles.cardKey} title={item.name}>
                                        {item.name}
                                    </span>
                                    <div className={styles.cardActions}>
                                        <span
                                            className={`${styles.statusBadge} ${item.disabled ? styles.statusDisabled : styles.statusActive}`}
                                        >
                                            {item.disabled
                                                ? t('codex_credentials.status_disabled')
                                                : t('codex_credentials.status_active')}
                                        </span>
                                        <ToggleSwitch
                                            checked={!item.disabled}
                                            onChange={(val) => void toggleFile(item.name, val)}
                                            disabled={disableControls || saving}
                                            ariaLabel={t('codex_credentials.toggle_label')}
                                        />
                                    </div>
                                </div>

                                {/* 详细信息 */}
                                {item.size != null && (
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>{t('codex_credentials.file_size')}:</span>
                                        <span className={styles.fieldValue}>{formatFileSize(item.size)}</span>
                                    </div>
                                )}
                                {item.modified != null && (
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>{t('codex_credentials.modified_time')}:</span>
                                        <span className={styles.fieldValue}>{formatTime(item.modified)}</span>
                                    </div>
                                )}

                                {/* 使用统计 */}
                                <div className={styles.cardStats}>
                                    <span className={`${styles.statPill} ${styles.statPillSuccess}`}>
                                        {t('codex_credentials.chart_success')}: {stats.success}
                                    </span>
                                    <span className={`${styles.statPill} ${styles.statPillFailure}`}>
                                        {t('codex_credentials.chart_failure')}: {stats.failure}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* 使用统计图表 */}
            {chartData.labels.length > 0 && (
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
