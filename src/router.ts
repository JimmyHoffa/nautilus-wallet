import { createRouter, createWebHashHistory, RouteRecordRaw } from "vue-router";
import LoadingView from "@/views/LoadingView.vue";
import AddView from "@/views/add/AddView.vue";
import AssetsView from "@/views/AssetsView.vue";
import ChartsView from "@/views/ChartsView.vue";
import ReceiveView from "@/views/ReceiveView.vue";
import AddReadOnlyView from "@/views/add/AddReadOnlyView.vue";
import RestoreView from "@/views/add/RestoreView.vue";
import AddStandardView from "@/views/add/AddStandardView.vue";
import SendView from "@/views/SendView.vue";
import AboutView from "@/views/AboutView.vue";
import SettingsView from "@/views/SettingsView.vue";

import AuthView from "@/views/connector/AuthView.vue";
import ConnectionsView from "@/views/connector/ConnectionsView.vue";
import SignTxConfirmView from "@/views/connector/SignTxConfirmView.vue";

const routes: Array<RouteRecordRaw> = [
  {
    path: "/",
    name: "loading",
    component: LoadingView,
    meta: { fullPage: true }
  },
  {
    path: "/add",
    name: "add-wallet",
    component: AddView,
    props: true,
    meta: { fullPage: true }
  },
  {
    path: "/add/read-only",
    name: "add-read-only-wallet",
    component: AddReadOnlyView,
    meta: { fullPage: true }
  },
  {
    path: "/add/restore",
    name: "restore-wallet",
    component: RestoreView,
    meta: { fullPage: true }
  },
  {
    path: "/add/new",
    name: "add-standard-wallet",
    component: AddStandardView,
    meta: { fullPage: true }
  },
  {
    path: "/assets",
    name: "assets-page",
    component: AssetsView
  },
  {
    path: "/charts",
    name: "charts-page",
    component: ChartsView
  },
  {
    path: "/receive",
    name: "receive-page",
    component: ReceiveView
  },
  {
    path: "/send",
    name: "send-page",
    component: SendView
  },
  {
    path: "/about",
    name: "about-nautilus",
    component: AboutView
  },
  {
    path: "/connector/auth",
    name: "connector-auth",
    component: AuthView
  },
  {
    path: "/connector/connections",
    name: "connector-connected",
    component: ConnectionsView
  },
  {
    path: "/connector/sign/tx",
    name: "connector-sign-tx",
    component: SignTxConfirmView
  },
  {
    path: "/wallet/settings",
    name: "wallet-settings",
    component: SettingsView
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export default router;
