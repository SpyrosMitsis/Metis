package com.workoutmaker.app.util

import kotlinx.coroutines.CancellationException

/** Recover operational failures without converting cancelled work into success. */
inline fun <T> runCatching(block: () -> T): Result<T> = try {
    Result.success(block())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (failure: Exception) {
    Result.failure(failure)
}
