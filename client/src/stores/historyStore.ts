import { defineStore } from "pinia";
import Vue, { computed, ref } from "vue";
import type { components } from "@/schema";
import { sortByObjectProp } from "@/utils/sorting";
import { HistoryFilters } from "@/components/History/HistoryFilters";
import {
    cloneHistory,
    createAndSelectNewHistory,
    deleteHistoryById,
    getCurrentHistoryFromServer,
    getHistoryByIdFromServer,
    getHistoryList,
    secureHistoryOnServer,
    setCurrentHistoryOnServer,
    updateHistoryFields,
} from "@/stores/services/history.services";
import { useUserLocalStorage } from "@/composables/userLocalStorage";

export type HistorySummary = components["schemas"]["HistorySummary"];

const isLoadingHistory = new Set();

export const useHistoryStore = defineStore("historyStore", () => {
    const historiesLoading = ref(false);
    const pinnedHistories = useUserLocalStorage<{ id: string }[]>("history-store-pinned-histories", []);
    const storedCurrentHistoryId = ref<string | null>(null);
    const storedFilterTexts = ref<{ [key: string]: string }>({});
    const storedHistories = ref<{ [key: string]: HistorySummary }>({});

    const histories = computed(() => {
        return Object.values(storedHistories.value).sort(sortByObjectProp("name"));
    });

    const getFirstHistoryId = computed(() => {
        return histories.value[0]?.id ?? null;
    });

    const currentHistory = computed(() => {
        if (storedCurrentHistoryId.value !== null) {
            return storedHistories.value[storedCurrentHistoryId.value];
        }
        return null;
    });

    const currentHistoryId = computed(() => {
        if (storedCurrentHistoryId.value === null || !(storedCurrentHistoryId.value in storedHistories.value)) {
            return getFirstHistoryId.value;
        } else {
            return storedCurrentHistoryId.value;
        }
    });

    const currentFilterText = computed(() => {
        if (currentHistoryId.value) {
            return storedFilterTexts.value[currentHistoryId.value];
        } else {
            return "";
        }
    });

    const getHistoryById = computed(() => {
        return (historyId: string) => {
            return storedHistories.value[historyId] ?? null;
        };
    });

    const getHistoryNameById = computed(() => {
        return (historyId: string) => {
            const history = storedHistories.value[historyId];
            if (history) {
                return history.name;
            } else {
                return "...";
            }
        };
    });

    async function setCurrentHistory(historyId: string) {
        const currentHistory = await setCurrentHistoryOnServer(historyId);
        selectHistory(currentHistory as HistorySummary);
        setFilterText(historyId, "");
    }

    function setCurrentHistoryId(historyId: string) {
        storedCurrentHistoryId.value = historyId;
    }

    function setFilterText(historyId: string, filterText: string) {
        Vue.set(storedFilterTexts.value, historyId, filterText);
    }

    function setHistory(history: HistorySummary) {
        Vue.set(storedHistories.value, history.id, history);
    }

    function setHistories(histories: HistorySummary[]) {
        // The incoming history list may contain less information than the already stored
        // histories, so we ensure that already available details are not getting lost.
        const enrichedHistories = histories.map((history) => {
            const historyState = storedHistories.value[history.id] || {};
            return Object.assign({}, historyState, history);
        });
        // Histories are provided as list but stored as map.
        const newMap = enrichedHistories.reduce((acc, h) => ({ ...acc, [h.id]: h }), {}) as {
            [key: string]: HistorySummary;
        };
        // Ensure that already stored histories, which are not available in the incoming array,
        // are not lost. This happens e.g. with shared histories since they have different owners.
        Object.values(storedHistories.value).forEach((history) => {
            const historyId = history.id;
            if (!newMap[historyId]) {
                newMap[historyId] = history;
            }
        });
        // Update stored histories
        storedHistories.value = newMap;
    }

    function setHistoriesLoading(loading: boolean) {
        historiesLoading.value = loading;
    }

    function pinHistory(historyId: string) {
        pinnedHistories.value.push({ id: historyId });
    }

    function unpinHistory(historyId: string) {
        pinnedHistories.value = pinnedHistories.value.filter((h) => h.id !== historyId);
    }

    function selectHistory(history: HistorySummary) {
        setHistory(history);
        setCurrentHistoryId(history.id);
    }

    async function applyFilters(historyId: string, filters: Record<string, string | boolean>) {
        if (currentHistoryId.value !== historyId) {
            await setCurrentHistory(historyId);
        }
        const filterText = HistoryFilters.getFilterText(HistoryFilters.getValidFilterSettings(filters));
        setFilterText(historyId, filterText);
    }

    async function copyHistory(history: HistorySummary, name: string, copyAll: boolean) {
        const newHistory = (await cloneHistory(history, name, copyAll)) as HistorySummary;
        return setCurrentHistory(newHistory.id);
    }

    async function createNewHistory() {
        const newHistory = await createAndSelectNewHistory();
        return selectHistory(newHistory as HistorySummary);
    }

    function getNextAvailableHistoryId(excludedIds: string[]) {
        const historyIds = Object.keys(storedHistories.value);
        const filteredHistoryIds = historyIds.filter((id) => !excludedIds.includes(id));
        return filteredHistoryIds[0];
    }

    async function deleteHistory(historyId: string, purge: boolean) {
        const deletedHistory = (await deleteHistoryById(historyId, purge)) as HistorySummary;
        const nextAvailableHistoryId = getNextAvailableHistoryId([deletedHistory.id]);
        if (nextAvailableHistoryId) {
            await setCurrentHistory(nextAvailableHistoryId);
        } else {
            await createNewHistory();
        }
        Vue.delete(storedHistories.value, deletedHistory.id);
    }

    async function loadCurrentHistory() {
        const history = await getCurrentHistoryFromServer();
        selectHistory(history as HistorySummary);
    }

    async function loadHistories() {
        if (!historiesLoading.value) {
            setHistoriesLoading(true);
            await getHistoryList()
                .then((histories) => setHistories(histories))
                .catch((error) => console.warn(error))
                .finally(() => {
                    setHistoriesLoading(false);
                });
        }
    }

    async function loadHistoryById(historyId: string) {
        if (!isLoadingHistory.has(historyId)) {
            await getHistoryByIdFromServer(historyId)
                .then((history) => setHistory(history as HistorySummary))
                .catch((error: Error) => console.warn(error))
                .finally(() => {
                    isLoadingHistory.delete(historyId);
                });
            isLoadingHistory.add(historyId);
        }
    }

    async function secureHistory(history: HistorySummary) {
        const securedHistory = await secureHistoryOnServer(history);
        setHistory(securedHistory as HistorySummary);
    }

    async function updateHistory({ id, ...update }: HistorySummary) {
        const savedHistory = await updateHistoryFields(id, update);
        setHistory(savedHistory as HistorySummary);
    }

    return {
        histories,
        currentHistory,
        currentHistoryId,
        currentFilterText,
        pinnedHistories,
        getHistoryById,
        getHistoryNameById,
        setCurrentHistory,
        setCurrentHistoryId,
        setFilterText,
        setHistory,
        setHistories,
        pinHistory,
        unpinHistory,
        selectHistory,
        applyFilters,
        copyHistory,
        createNewHistory,
        deleteHistory,
        loadCurrentHistory,
        loadHistories,
        loadHistoryById,
        secureHistory,
        updateHistory,
        historiesLoading,
    };
});
