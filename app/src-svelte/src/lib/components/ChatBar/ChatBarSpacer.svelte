<script lang="ts">
	// Reserves scroll room at the end of any view that shows the floating chat
	// bar (fixed at bottom-6 in the app layout), so the last content item can
	// scroll clear of the collapsed pill instead of hiding behind it. Render as
	// the last child of the view's scrollable content instead of an ad-hoc pb-*
	// utility, so every chat surface reserves the same space.
</script>

<div class="h-24 shrink-0" aria-hidden="true"></div>
