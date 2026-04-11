<script setup lang="ts">
import MemberDislikeButton from "./MemberDislikeButton.vue";
import MemberLikeButton from "./MemberLikeButton.vue";

defineProps<{
  memberId: string | number;
}>();
</script>

<template>
  <div class="reactions">
    <MemberLikeButton :member-id="memberId" variant="inline" />
    <MemberDislikeButton :member-id="memberId" variant="inline" />
  </div>
</template>

<style scoped>
.reactions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  vertical-align: middle;
}
</style>
