package com.workoutmaker.app.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class RoomMigration9Test {
    @Test fun existingVersion8StrengthRowsSurviveAndRoomValidatesVersion9() = runBlocking {
        val context=ApplicationProvider.getApplicationContext<Context>()
        val name="migration-fixture-${UUID.randomUUID()}.db"
        val asset=InstrumentationRegistry.getInstrumentation().context.assets.open("room_schema8.json").bufferedReader().use{it.readText()}
        val schema=JSONObject(asset).getJSONObject("database")
        try {
            context.openOrCreateDatabase(name,Context.MODE_PRIVATE,null).use { db ->
                val entities=schema.getJSONArray("entities")
                for(i in 0 until entities.length()) {
                    val entity=entities.getJSONObject(i);val table=entity.getString("tableName")
                    db.execSQL(entity.getString("createSql").replace("\${TABLE_NAME}",table))
                    val indices=entity.getJSONArray("indices")
                    for(j in 0 until indices.length())db.execSQL(indices.getJSONObject(j).getString("createSql").replace("\${TABLE_NAME}",table))
                }
                val setup=schema.getJSONArray("setupQueries")
                for(i in 0 until setup.length())db.execSQL(setup.getString(i))
                db.execSQL("INSERT INTO strength_workout(id,name,startedAt,endedAt,durationSec,totalVolumeKg,note,synced) VALUES('fixture','Fixture',1,2,1,0,'',1)")
                db.execSQL("INSERT INTO strength_set(id,workoutId,exerciseName,muscle,idx,weightKg,reps,isWarmup,note) VALUES('set','fixture','Plank','Core',1,0,30,0,'')")
                db.version=8
            }
            val room=Room.databaseBuilder(context,AppDatabase::class.java,name).addMigrations(MIGRATION_8_9).build()
            try {
                assertNotNull(room.strengthDao().workout("fixture"))
                val sets=room.strengthDao().setsForWorkout("fixture")
                assertEquals(1,sets.size);assertEquals("reps",sets.single().quantityUnit)
                assertNull(room.strengthDao().workout("fixture")!!.plannedWorkoutId)
            } finally {room.close()}
        } finally {context.deleteDatabase(name)}
    }
}
