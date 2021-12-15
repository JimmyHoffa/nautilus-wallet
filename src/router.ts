import { createRouter, createWebHashHistory, RouteRecordRaw } from "vue-router";
import AddView from "@/views/add/AddView.vue";
import AddReadOnlyView from "@/views/add/AddReadOnlyView.vue";
import AssetsView from "@/views/AssetsView.vue";
import ReceiveView from "@/views/ReceiveView.vue";

const routes: Array<RouteRecordRaw> = [
  {
    path: "/",
    name: "home-page",
    component: AddView,
    meta: { fullPage: true }
  },
  {
    path: "/add/read-only",
    name: "add-read-only-wallet",
    component: AddReadOnlyView,
    meta: { fullPage: true }
  },
  {
    path: "/assets",
    name: "assets-page",
    component: AssetsView
  },
  {
    path: "/receive",
    name: "receive-page",
    component: ReceiveView
  }
];

const router = createRouter({
  history: createWebHashHistory(),
  routes
});

export default router;
